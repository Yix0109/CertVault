using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CertVault
{
    /// <summary>
    /// 宿主文件桥：把页面发来的 {cv:1,id,op,...} 用 System.IO 执行，再回一包 {cv:1,id,ok,result|error}。
    /// 只实现 app/store.js 真正用到的那几个原语，其余交给页面里的句柄垫片（app/bridge.js）。
    /// </summary>
    internal sealed class HostBridge
    {
        private readonly JavaScriptSerializer ser = new JavaScriptSerializer();
        private readonly string statePath;

        public HostBridge()
        {
            ser.MaxJsonLength = int.MaxValue;
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CertVault");
            Directory.CreateDirectory(dir);
            statePath = Path.Combine(dir, "host.json");
        }

        /// <summary>不是本桥的消息返回 null（交给别的处理器）。</summary>
        public string Handle(string json)
        {
            if (string.IsNullOrEmpty(json) || json.IndexOf("\"cv\"") < 0) return null;
            Dictionary<string, object> msg;
            try { msg = ser.Deserialize<Dictionary<string, object>>(json); }
            catch { return null; }
            if (msg == null || !msg.ContainsKey("cv")) return null;

            object idValue;
            msg.TryGetValue("id", out idValue);
            string id = idValue == null ? "" : Convert.ToString(idValue, CultureInfo.InvariantCulture);
            string op = msg.ContainsKey("op") ? Convert.ToString(msg["op"], CultureInfo.InvariantCulture) : "";

            Dictionary<string, object> reply = new Dictionary<string, object>();
            reply["cv"] = 1;
            reply["id"] = id;
            try
            {
                object result = Dispatch(op, msg);
                reply["ok"] = true;
                reply["result"] = result;
            }
            catch (Exception ex)
            {
                reply["ok"] = false;
                Dictionary<string, object> err = new Dictionary<string, object>();
                err["name"] = ErrorName(ex);
                err["message"] = ex.Message;
                reply["error"] = err;
            }
            return ser.Serialize(reply);
        }

        private static string ErrorName(Exception ex)
        {
            if (ex is FileNotFoundException || ex is DirectoryNotFoundException) return "NotFoundError";
            if (ex is UnauthorizedAccessException) return "NotAllowedError";
            if (ex is IOException) return "IOError";
            return "Error";
        }

        private static string Arg(Dictionary<string, object> msg, string key)
        {
            object value;
            if (!msg.TryGetValue(key, out value) || value == null) return null;
            return Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static bool ArgBool(Dictionary<string, object> msg, string key)
        {
            object value;
            if (!msg.TryGetValue(key, out value) || value == null) return false;
            if (value is bool) return (bool)value;
            return string.Equals(Convert.ToString(value, CultureInfo.InvariantCulture), "true", StringComparison.OrdinalIgnoreCase);
        }

        private object Dispatch(string op, Dictionary<string, object> msg)
        {
            string path = Arg(msg, "path");
            switch (op)
            {
                case "pick": return Pick();
                case "last": return Last();
                case "stat": return Stat(path);
                case "list": return List(path);
                case "touch": Touch(path); return new Dictionary<string, object>();
                case "mkdir": Mkdir(path); return new Dictionary<string, object>();
                case "read": return Read(path);
                case "write": Write(path, Arg(msg, "data")); return new Dictionary<string, object>();
                case "remove": Remove(path, ArgBool(msg, "recursive")); return new Dictionary<string, object>();
                case "open": OpenFolder(path); return new Dictionary<string, object>();
                case "saveas": return SaveAs(Arg(msg, "name"), Arg(msg, "data"));
                case "openread": return OpenRead(Arg(msg, "kind"));
                default: throw new InvalidOperationException("未知的文件操作：" + op);
            }
        }

        // ---------- 另存为 / 打开文件（导入导出 Excel 用） ----------
        private object SaveAs(string name, string base64)
        {
            // 自动化测试钩子：CERTVAULT_SAVEAS 指定目录或完整文件名时跳过对话框
            string autoSave = Environment.GetEnvironmentVariable("CERTVAULT_SAVEAS");
            if (!string.IsNullOrEmpty(autoSave))
            {
                bool lookDir = autoSave.EndsWith("\\") || autoSave.EndsWith("/") || Path.GetExtension(autoSave) == "";
                string target;
                if (Directory.Exists(autoSave) || lookDir)
                {
                    if (!Directory.Exists(autoSave)) Directory.CreateDirectory(autoSave);
                    target = Path.Combine(autoSave, string.IsNullOrEmpty(name) ? "CertVault-导出.xlsx" : name);
                }
                else
                {
                    target = autoSave;
                }
                string dir = Path.GetDirectoryName(target);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                Write(target, base64);
                Dictionary<string, object> auto = new Dictionary<string, object>();
                auto["path"] = target;
                auto["name"] = Path.GetFileName(target);
                return auto;
            }
            using (SaveFileDialog dialog = new SaveFileDialog())
            {
                dialog.Title = "导出 Excel";
                dialog.Filter = "Excel 工作簿 (*.xlsx)|*.xlsx|所有文件 (*.*)|*.*";
                dialog.OverwritePrompt = true;
                dialog.AddExtension = true;
                dialog.DefaultExt = "xlsx";
                dialog.FileName = string.IsNullOrEmpty(name) ? "CertVault-导出.xlsx" : name;
                string download = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
                if (Directory.Exists(download)) dialog.InitialDirectory = download;

                IWin32Window owner = Application.OpenForms.Count > 0 ? (IWin32Window)Application.OpenForms[0] : null;
                DialogResult choice = owner == null ? dialog.ShowDialog() : dialog.ShowDialog(owner);
                Dictionary<string, object> result = new Dictionary<string, object>();
                if (choice != DialogResult.OK || string.IsNullOrEmpty(dialog.FileName))
                {
                    result["path"] = null;
                    return result;
                }
                Write(dialog.FileName, base64);
                result["path"] = dialog.FileName;
                result["name"] = Path.GetFileName(dialog.FileName);
                return result;
            }
        }

        private object OpenRead(string kind)
        {
            // 自动化测试钩子：CERTVAULT_OPENREAD 指定文件或目录时跳过对话框
            string autoOpen = Environment.GetEnvironmentVariable("CERTVAULT_OPENREAD");
            if (!string.IsNullOrEmpty(autoOpen))
            {
                string file = autoOpen;
                if (Directory.Exists(autoOpen))
                {
                    string[] hits = Directory.GetFiles(autoOpen, "*.xlsx");
                    if (hits.Length == 0) hits = Directory.GetFiles(autoOpen, "*.csv");
                    file = hits.Length > 0 ? hits[0] : autoOpen;
                }
                if (!File.Exists(file))
                {
                    Dictionary<string, object> missing = new Dictionary<string, object>();
                    missing["path"] = null;
                    return missing;
                }
                byte[] autoBytes = File.ReadAllBytes(file);
                Dictionary<string, object> autoResult = new Dictionary<string, object>();
                autoResult["path"] = file;
                autoResult["name"] = Path.GetFileName(file);
                autoResult["data"] = Convert.ToBase64String(autoBytes);
                return autoResult;
            }
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "选择要导入的文件";
                dialog.Filter = "Excel 工作簿 (*.xlsx;*.xls)|*.xlsx;*.xls|CSV 文本 (*.csv)|*.csv|所有文件 (*.*)|*.*";
                dialog.CheckFileExists = true;
                dialog.Multiselect = false;
                string download = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
                if (Directory.Exists(download)) dialog.InitialDirectory = download;

                IWin32Window owner = Application.OpenForms.Count > 0 ? (IWin32Window)Application.OpenForms[0] : null;
                DialogResult choice = owner == null ? dialog.ShowDialog() : dialog.ShowDialog(owner);
                Dictionary<string, object> result = new Dictionary<string, object>();
                if (choice != DialogResult.OK || string.IsNullOrEmpty(dialog.FileName))
                {
                    result["path"] = null;
                    return result;
                }
                byte[] bytes = File.ReadAllBytes(dialog.FileName);
                result["path"] = dialog.FileName;
                result["name"] = Path.GetFileName(dialog.FileName);
                result["data"] = Convert.ToBase64String(bytes);
                return result;
            }
        }

        // ---------- 文件夹记忆 ----------
        private Dictionary<string, object> LoadState()
        {
            string file = statePath;
            if (!File.Exists(file))
            {
                if (!File.Exists(statePath + ".tmp")) return new Dictionary<string, object>();
                file = statePath + ".tmp"; // 上次写到一半中断：用残留 .tmp 恢复
            }
            try
            {
                Dictionary<string, object> state = ser.Deserialize<Dictionary<string, object>>(File.ReadAllText(file, Encoding.UTF8));
                return state ?? new Dictionary<string, object>();
            }
            catch
            {
                // 内容损坏：改名留档，避免每次启动都读到坏文件、lastFolder 永远丢失
                try { File.Move(file, file + ".bad-" + DateTime.Now.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture)); }
                catch (Exception) { }
                return new Dictionary<string, object>();
            }
        }

        private void SaveLastFolder(string folder)
        {
            Dictionary<string, object> state = LoadState();
            state["lastFolder"] = folder;
            state["lastOpen"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss", CultureInfo.InvariantCulture);
            try { WriteTextAtomic(statePath, ser.Serialize(state)); }
            catch { }
        }

        // 文本原子写：tmp 落盘后整文件替换，避免 host.json 被写坏导致「记住的文件夹」丢失
        private static void WriteTextAtomic(string path, string text)
        {
            string temp = path + ".tmp";
            File.WriteAllText(temp, text, new UTF8Encoding(false));
            if (File.Exists(path))
            {
                try { File.Replace(temp, path, null, true); return; }
                catch (Exception) { }
            }
            File.Copy(temp, path, true);
            try { File.Delete(temp); } catch (Exception) { }
        }

        private string Remembered()
        {
            Dictionary<string, object> state = LoadState();
            object value;
            if (!state.TryGetValue("lastFolder", out value) || value == null) return null;
            string folder = Convert.ToString(value, CultureInfo.InvariantCulture);
            if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return null;
            return folder;
        }

        // 首次启动的默认数据目录：程序文件夹的「同级」CertVault-数据\（程序与数据分开放，各自可独立拷走）
        private static string DefaultFolder()
        {
            try
            {
                string exeDir = AppDomain.CurrentDomain.BaseDirectory;
                if (string.IsNullOrEmpty(exeDir)) return null;
                exeDir = exeDir.TrimEnd('\\', '/');
                string parent = Path.GetDirectoryName(exeDir);
                if (string.IsNullOrEmpty(parent)) return null;
                return Path.Combine(parent, "CertVault-数据");
            }
            catch (Exception) { return null; }
        }

        // 建好数据目录骨架（data / images / backup），失败返回 false
        private static bool EnsureDataLayout(string folder)
        {
            try
            {
                Directory.CreateDirectory(folder);
                Directory.CreateDirectory(Path.Combine(folder, "data"));
                Directory.CreateDirectory(Path.Combine(folder, "images"));
                Directory.CreateDirectory(Path.Combine(folder, "backup"));
                return true;
            }
            catch (Exception) { return false; }
        }

        private object Last()
        {
            string folder = Remembered();
            if (folder == null)
            {
                // 首次使用：自动建好「程序同级\CertVault-数据」，不用先弹对话框挑目录
                string def = DefaultFolder();
                if (!string.IsNullOrEmpty(def) && EnsureDataLayout(def))
                {
                    try { SaveLastFolder(def); } catch (Exception) { }
                    folder = def;
                }
            }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["path"] = folder;
            return result;
        }

        private object Pick()
        {
            // 自动化 E2E：CERTVAULT_AUTOFOLDER 指定目录时跳过系统对话框
            string auto = Environment.GetEnvironmentVariable("CERTVAULT_AUTOFOLDER");
            if (!string.IsNullOrEmpty(auto) && Directory.Exists(auto))
            {
                SaveLastFolder(auto);
                Dictionary<string, object> autoResult = new Dictionary<string, object>();
                autoResult["path"] = auto;
                return autoResult;
            }

            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 CertVault 的数据文件夹（数据文件与截图都会保存在这里，整个文件夹可以随时拷走）";

                dialog.ShowNewFolderButton = true;
                string last = Remembered();
                if (last != null)
                {
                    dialog.SelectedPath = last;
                }
                else
                {
                    // 首次使用：优先给出「程序同级\CertVault-数据」，建不出来再退回我的文档
                    try
                    {
                        string def = DefaultFolder();
                        if (string.IsNullOrEmpty(def) || !EnsureDataLayout(def))
                        {
                            def = Path.Combine(
                                Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "CertVault数据");
                            if (!Directory.Exists(def)) Directory.CreateDirectory(def);
                        }
                        dialog.SelectedPath = def;
                    }
                    catch { }
                }

                IWin32Window owner = null;
                if (Application.OpenForms.Count > 0) owner = Application.OpenForms[0];
                DialogResult choice = owner == null ? dialog.ShowDialog() : dialog.ShowDialog(owner);
                Dictionary<string, object> result = new Dictionary<string, object>();
                if (choice != DialogResult.OK || string.IsNullOrEmpty(dialog.SelectedPath))
                {
                    result["path"] = null;
                    return result;
                }
                SaveLastFolder(dialog.SelectedPath);
                result["path"] = dialog.SelectedPath;
                return result;
            }
        }

        // ---------- 文件系统原语 ----------
        private static object Stat(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("缺少 path");
            if (Directory.Exists(path))
            {
                Dictionary<string, object> dir = new Dictionary<string, object>();
                dir["kind"] = "dir";
                dir["size"] = 0;
                return dir;
            }
            if (File.Exists(path))
            {
                Dictionary<string, object> file = new Dictionary<string, object>();
                file["kind"] = "file";
                file["size"] = new FileInfo(path).Length;
                return file;
            }
            return null;
        }

        private static object List(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("缺少 path");
            if (!Directory.Exists(path)) throw new DirectoryNotFoundException("目录不存在：" + path);
            List<object> entries = new List<object>();
            foreach (string dirPath in Directory.GetDirectories(path))
            {
                Dictionary<string, object> item = new Dictionary<string, object>();
                item["name"] = Path.GetFileName(dirPath);
                item["kind"] = "dir";
                item["size"] = 0;
                entries.Add(item);
            }
            foreach (string filePath in Directory.GetFiles(path))
            {
                Dictionary<string, object> item = new Dictionary<string, object>();
                item["name"] = Path.GetFileName(filePath);
                item["kind"] = "file";
                try { item["size"] = new FileInfo(filePath).Length; } catch { item["size"] = 0; }
                entries.Add(item);
            }
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["entries"] = entries;
            return result;
        }

        private static void Touch(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("缺少 path");
            string parent = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            if (!File.Exists(path))
            {
                using (FileStream fs = File.Create(path)) { }
            }
        }

        private static void Mkdir(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("缺少 path");
            Directory.CreateDirectory(path);
        }

        private static object Read(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("缺少 path");
            if (!File.Exists(path) && File.Exists(path + ".tmp")) path = path + ".tmp"; // 上次写入中断时用残留 .tmp 兜底
            if (!File.Exists(path)) throw new FileNotFoundException("文件不存在：" + path, path);
            byte[] bytes = File.ReadAllBytes(path);
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["data"] = Convert.ToBase64String(bytes);
            result["mtime"] = new DateTimeOffset(File.GetLastWriteTimeUtc(path)).ToUnixTimeMilliseconds();
            return result;
        }

        private static void Write(string path, string base64)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("缺少 path");
            string parent = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            byte[] bytes = string.IsNullOrEmpty(base64) ? new byte[0] : Convert.FromBase64String(base64);
            string temp = path + ".tmp";
            File.WriteAllBytes(temp, bytes);
            // 原子替换：先落 .tmp，再整文件覆盖；中途崩溃最多留下 .tmp，目标文件不会消失。
            if (File.Exists(path))
            {
                try { File.Replace(temp, path, null, true); return; }
                catch (Exception) { /* 个别卷不支持 Replace，退回下面的覆盖写 */ }
            }
            File.Copy(temp, path, true);
            try { File.Delete(temp); } catch (Exception) { }
        }

        private static void Remove(string path, bool recursive)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("缺少 path");
            if (Directory.Exists(path))
            {
                if (!recursive && Directory.GetFileSystemEntries(path).Length > 0)
                    throw new IOException("目录不为空，不能直接删除：" + path);
                Directory.Delete(path, true);
                return;
            }
            if (File.Exists(path)) { File.Delete(path); return; }
            throw new FileNotFoundException("不存在：" + path, path);
        }

        private static void OpenFolder(string path)
        {
            string target = path;
            if (string.IsNullOrEmpty(target))
            {
                target = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            }
            if (Directory.Exists(target)) System.Diagnostics.Process.Start("explorer.exe", "\"" + target + "\"");
            else if (File.Exists(target)) System.Diagnostics.Process.Start("explorer.exe", "/select,\"" + target + "\"");
        }
    }
}
