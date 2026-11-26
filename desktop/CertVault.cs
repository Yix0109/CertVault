using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace CertVault
{
    internal static class Program
    {
        private const string MutexName = "CertVaultDesktopSingleInstance_v1";
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValue = "CertVault";

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [STAThread]
        private static void Main(string[] args)
        {
            bool startHidden = false;
            for (int i = 0; i < args.Length; i++)
            {
                if (string.Equals(args[i], "--tray", StringComparison.OrdinalIgnoreCase)) startHidden = true;
            }

            bool createdNew;
            Mutex mutex = new Mutex(true, MutexName, out createdNew);
            if (!createdNew)
            {
                ActivateRunningInstance();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new MainForm(startHidden));
            }
            finally
            {
                GC.KeepAlive(mutex);
            }
        }

        private static void ActivateRunningInstance()
        {
            Process current = Process.GetCurrentProcess();
            Process[] all = Process.GetProcessesByName(current.ProcessName);
            for (int i = 0; i < all.Length; i++)
            {
                if (all[i].Id != current.Id && all[i].MainWindowHandle != IntPtr.Zero)
                {
                    ShowWindow(all[i].MainWindowHandle, 9);
                    SetForegroundWindow(all[i].MainWindowHandle);
                    return;
                }
            }
        }

        public static bool AutostartEnabled
        {
            get
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, false))
                {
                    if (key == null) return false;
                    return key.GetValue(RunValue) != null;
                }
            }
        }

        public static void SetAutostart(bool enabled)
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey, true))
            {
                if (key == null) return;
                if (enabled) key.SetValue(RunValue, "\"" + Application.ExecutablePath + "\" --tray");
                else if (key.GetValue(RunValue) != null) key.DeleteValue(RunValue, false);
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private WebView2 web;
        private NotifyIcon tray;
        private bool allowExit;
        private bool balloonShown;
        private string appRoot;
        private HostBridge bridge;

        public MainForm(bool startHidden)
        {
            Text = "CertVault · CA 证书 / 账号凭证 管理";
            ClientSize = new Size(1520, 940);
            MinimumSize = new Size(1100, 700);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(14, 22, 34);
            Font = new Font("Microsoft YaHei UI", 9f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { }

            appRoot = LocateAppRoot();
            bridge = new HostBridge();
            BuildTray();

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Color.FromArgb(14, 22, 34);
            Controls.Add(web);

            Load += OnFormLoad;
            FormClosing += OnFormClosing;
            Resize += OnFormResize;
            Shown += delegate { if (startHidden) { Hide(); } };
        }

        private string LocateAppRoot()
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string[] candidates = new string[]
            {
                Path.Combine(exeDir, "app"),
                Path.GetFullPath(Path.Combine(exeDir, @"..\..\app")),
                Path.GetFullPath(Path.Combine(exeDir, @"..\app"))
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(Path.Combine(candidates[i], "index.html"))) return candidates[i];
            }
            return candidates[0];
        }

        private void BuildTray()
        {
            tray = new NotifyIcon();
            try { tray.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { tray.Icon = SystemIcons.Application; }
            tray.Text = "CertVault · CA 证书 / 账号凭证 管理";
            tray.Visible = true;

            ContextMenuStrip menu = new ContextMenuStrip();
            ToolStripMenuItem show = new ToolStripMenuItem("显示主窗口");
            show.Click += delegate { RestoreWindow(); };
            ToolStripMenuItem auto = new ToolStripMenuItem("开机自动启动（最小化到托盘）");
            auto.CheckOnClick = true;
            auto.Checked = Program.AutostartEnabled;
            auto.Click += delegate(object sender, EventArgs e)
            {
                ToolStripMenuItem item = (ToolStripMenuItem)sender;
                try { Program.SetAutostart(item.Checked); }
                catch (Exception ex) { MessageBox.Show("设置开机启动失败：" + ex.Message, "CertVault"); }
            };
            ToolStripMenuItem openFolder = new ToolStripMenuItem("打开程序所在文件夹");
            openFolder.Click += delegate
            {
                try { Process.Start("explorer.exe", "/select,\"" + Application.ExecutablePath + "\""); }
                catch { }
            };
            ToolStripMenuItem exit = new ToolStripMenuItem("退出");
            exit.Click += delegate { allowExit = true; Close(); };
            menu.Items.Add(show);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(auto);
            menu.Items.Add(openFolder);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(exit);
            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { RestoreWindow(); };
            // 左键单击托盘图标 = 显示主窗口（用户要求：不必先右键再点「显示主窗口」）
            tray.MouseUp += delegate(object sender, MouseEventArgs e)
            {
                if (e.Button == MouseButtons.Left) RestoreWindow();
            };
        }

        private void RestoreWindow()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            ShowInTaskbar = true;
            BringToFront();
            Activate();
            // 从托盘恢复时确保一定拿到前台焦点（Win32 允许的范围内）
            try
            {
                IntPtr h = Handle;
                SetForegroundWindow(h);
            }
            catch { }
        }

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        private async void OnFormLoad(object sender, EventArgs e)
        {
            try
            {
                string cacheDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CertVault", "WebView2");
                Directory.CreateDirectory(cacheDir);

                bool debug = Environment.GetEnvironmentVariable("CERTVAULT_DEBUG") == "1";
                string flags = "--disable-features=msWebOOUI,msPdfOOUI";
                if (debug) flags += " --remote-debugging-port=9340";
                CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions(flags);
                CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, cacheDir, options);
                await web.EnsureCoreWebView2Async(env);

                CoreWebView2 core = web.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = debug;
                core.Settings.AreDevToolsEnabled = debug;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = true;

                // 说明：虚拟主机映射在含中文/空格的路径上实测不可用（NAV FAIL Unknown），
                // 因此入口统一走 file://（WebView2 下 isSecureContext 仍为 true，IndexedDB 可用）。

                core.PermissionRequested += delegate(object s, CoreWebView2PermissionRequestedEventArgs ev)
                {
                    ev.State = CoreWebView2PermissionState.Allow;
                };
                core.NewWindowRequested += delegate(object s, CoreWebView2NewWindowRequestedEventArgs ev)
                {
                    ev.Handled = true;
                    try { Process.Start(ev.Uri); } catch { }
                };
                // 下载（导出 CSV）走 WebView2 默认行为：落到系统下载目录，不额外接管。
                core.DownloadStarting += delegate(object s, CoreWebView2DownloadStartingEventArgs ev)
                {
                    ev.Handled = false;
                };
                // 文件桥：先喂给 HostBridge（{cv:1,id,op}），不是本桥的消息再往下走
                string bridgeScript = LoadBridgeScript();
                if (bridgeScript != null)
                {
                    await core.AddScriptToExecuteOnDocumentCreatedAsync(bridgeScript);
                    Log("BRIDGE INJECTED " + bridgeScript.Length + " chars");
                }
                else
                {
                    Log("BRIDGE MISSING app/bridge.js");
                }

                // 调试用：页面可 postMessage({"type":"cv-shot","path":"..."}) 让宿主立刻截一张图
                core.WebMessageReceived += delegate(object s, CoreWebView2WebMessageReceivedEventArgs ev)
                {
                    string text = null;
                    try { text = ev.WebMessageAsJson; } catch { }
                    if (text == null) return;
                    string bridgeReply = null;
                    try { bridgeReply = bridge.Handle(text); }
                    catch (Exception ex) { Log("BRIDGE EXCEPTION " + ex.Message); }
                    if (bridgeReply != null)
                    {
                        try { core.PostWebMessageAsJson(bridgeReply); }
                        catch (Exception ex) { Log("BRIDGE REPLY FAIL " + ex.Message); }
                        return;
                    }
                    if (text.IndexOf("cv-shot") < 0) return;
                    int idx = text.IndexOf("\"path\"");
                    if (idx < 0) return;
                    int colon = text.IndexOf(':', idx);
                    int start = text.IndexOf('"', colon + 1);
                    int end = text.IndexOf('"', start + 1);
                    if (start < 0 || end < 0) return;
                    string path = text.Substring(start + 1, end - start - 1).Replace("\\\\", "\\");
                    CaptureTo(path);
                };

                core.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs ev)
                {
                    if (ev.IsSuccess)
                    {
                        Log("NAV OK " + core.Source);
                        CaptureIfRequested();
                        return;
                    }
                    Log("NAV FAIL " + ev.WebErrorStatus + " " + core.Source);
                    ShowLoadError(ev.WebErrorStatus.ToString());
                };

                Log("APPROOT " + appRoot);
                string entry = new Uri(Path.Combine(appRoot, "index.html")).AbsoluteUri;
                Log("NAV START " + entry);
                core.Navigate(entry);
            }
            catch (Exception ex)
            {
                string msg = ex.Message == null ? "" : ex.Message;
                if (msg.IndexOf("WebView2", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    ShowLoadError("本机缺少 Microsoft Edge WebView2 运行时（程序界面依赖它渲染）。" +
                        Environment.NewLine + "请安装后重新打开：https://developer.microsoft.com/microsoft-edge/webview2/");
                }
                else
                {
                    ShowLoadError(msg);
                }
            }
        }

        private string LoadBridgeScript()
        {
            string[] candidates = new string[]
            {
                Path.Combine(appRoot, "bridge.js"),
                Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "bridge.js")
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(candidates[i]))
                {
                    try { return File.ReadAllText(candidates[i], System.Text.Encoding.UTF8); }
                    catch { }
                }
            }
            return null;
        }

        private async void CaptureTo(string path)
        {
            try
            {
                await Task.Delay(300);
                using (FileStream fs = File.Create(path))
                {
                    await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, fs);
                }
                Log("SHOT OK " + path);
            }
            catch (Exception ex)
            {
                Log("SHOT FAIL " + ex.Message);
            }
        }

        // 仅调试/截屏用：设置 CERTVAULT_SHOT=<png 路径> 启动，导航成功后自动截一张整页图。
        private async void CaptureIfRequested()
        {
            string shotPath = Environment.GetEnvironmentVariable("CERTVAULT_SHOT");
            if (string.IsNullOrEmpty(shotPath)) return;
            try
            {
                await Task.Delay(2600);
                using (FileStream fs = File.Create(shotPath))
                {
                    await web.CoreWebView2.CapturePreviewAsync(
                        CoreWebView2CapturePreviewImageFormat.Png, fs);
                }
                Log("SHOT OK " + shotPath);
            }
            catch (Exception ex)
            {
                Log("SHOT FAIL " + ex.Message);
            }
        }

        private void Log(string message)
        {
            try
            {
                string dir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CertVault");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "host.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine);
            }
            catch { }
        }

        private void ShowLoadError(string message)
        {
            Label lbl = new Label();
            lbl.Dock = DockStyle.Fill;
            lbl.ForeColor = Color.FromArgb(232, 237, 244);
            lbl.BackColor = Color.FromArgb(14, 22, 34);
            lbl.TextAlign = ContentAlignment.MiddleCenter;
            lbl.Text = "界面加载失败：" + message + Environment.NewLine + Environment.NewLine +
                       "请确认 CertVault.exe 同目录下有 app 文件夹（index.html / core.js / store.js / app.js）。" +
                       Environment.NewLine + "程序目录：" + appRoot;
            Controls.Clear();
            Controls.Add(lbl);
        }

        private void OnFormResize(object sender, EventArgs e)
        {
            // 说明：早期版本在最小化时直接 Hide()，导致「点任务栏图标」看起来像关闭了程序。
            // 现在最小化只收缩到任务栏，点任务栏图标即可还原；只有点右上角关闭按钮才收进托盘。
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!allowExit)
            {
                e.Cancel = true;
                Hide();
                if (!balloonShown && tray != null)
                {
                    balloonShown = true;
                    tray.BalloonTipTitle = "CertVault 仍在运行";
                    tray.BalloonTipText = "已收进托盘，到期提醒照常工作。左键单击托盘图标可打开主窗口，右键可退出。";
                    tray.ShowBalloonTip(3000);
                }
                return;
            }
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
        }
    }
}
