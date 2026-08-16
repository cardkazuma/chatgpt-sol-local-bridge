import { runCommand } from "../lib/exec.js";
import { splitArgs } from "../lib/text.js";
import { available, capturePath, psQuote, runExternal, runPowerShell, startCapture, stopCapture, unavailable } from "./common.js";

export const name = "Windows";

export function capabilities() {
  return {
    accessibility: available("powershell.exe") || available("pwsh"),
    inputEvent: available("powershell.exe") || available("pwsh"),
    vision: available("powershell.exe") || available("pwsh"),
    ocr: available("tesseract"),
    window: available("powershell.exe") || available("pwsh"),
    clipboard: available("powershell.exe") || available("pwsh"),
    notification: available("powershell.exe") || available("pwsh"),
    fileDialog: available("powershell.exe") || available("pwsh"),
    screenRecord: available("ffmpeg"),
    audio: available("ffmpeg") || available("ffplay"),
    scheduler: available("schtasks.exe"),
  };
}

export async function accessibility(action) {
  const args = splitArgs(action);
  const verb = (args.shift() || "apps").toLowerCase();
  const query = args.join(" ");
  const setup = `Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; $root=[System.Windows.Automation.AutomationElement]::RootElement;`;
  if (verb === "apps" || verb === "list") {
    return runPowerShell(`Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Depth 3`, { feature: "accessibility" });
  }
  if (!["find", "click", "type"].includes(verb) || !query) {
    return unavailable("accessibility action", "Supported Windows actions: apps, find <name>, click <name>, type <text>.");
  }
  if (verb === "type") {
    return runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; Set-Clipboard -Value ${psQuote(query)}; [System.Windows.Forms.SendKeys]::SendWait('^v'); 'typed via clipboard'`, { feature: "accessibility type" });
  }
  const find = `${setup} $all=$root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition); $matches=@($all | Where-Object {$_.Current.Name -like ${psQuote(`*${query}*`)}} | Select-Object -First 50);`;
  if (verb === "find") {
    return runPowerShell(`${find} $matches | ForEach-Object {[pscustomobject]@{Name=$_.Current.Name;ControlType=$_.Current.ControlType.ProgrammaticName;AutomationId=$_.Current.AutomationId;Enabled=$_.Current.IsEnabled}} | ConvertTo-Json -Depth 4`, { feature: "accessibility find" });
  }
  return runPowerShell(`${find} $el=$matches | Select-Object -First 1; if(-not $el){throw 'element not found'}; $p=$null; if($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$p)){([System.Windows.Automation.InvokePattern]$p).Invoke(); 'invoked'} else {$pt=$el.GetClickablePoint(); Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [Mouse]::SetCursorPos([int]$pt.X,[int]$pt.Y); [Mouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [Mouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero); 'clicked'}`, { feature: "accessibility click" });
}

export async function inputEvent(action) {
  const args = splitArgs(action);
  const verb = (args.shift() || "").toLowerCase();
  if (verb === "keys" && args.length) {
    return runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(args.join(" "))}); 'keys sent'`, { feature: "input_event" });
  }
  if (verb === "click" && args.length >= 1) {
    const coordinates = args.join(" ").split(/[\s,]+/).filter(Boolean).map(Number);
    const [x, y] = coordinates;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return unavailable("input_event click", "Use: click X Y or click X,Y");
    return runPowerShell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int X,int Y); [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [Mouse]::SetCursorPos(${x},${y}); [Mouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [Mouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero); 'clicked'`, { feature: "input_event" });
  }
  if (verb === "scroll" && Number.isFinite(Number(args[0]))) {
    return runPowerShell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Mouse { [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e); }'; [Mouse]::mouse_event(0x0800,0,0,${Number(args[0])},[UIntPtr]::Zero); 'scrolled'`, { feature: "input_event" });
  }
  return unavailable("input_event action", "Supported Windows actions: keys <SendKeys expression>, click X Y, scroll DELTA.");
}

export async function vision({ mode = "screenshot" } = {}) {
  const output = capturePath("screen", "png");
  const shot = await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save(${psQuote(output)},[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); ${psQuote(output)}`, { feature: "vision", timeoutMs: 30_000 });
  if (!shot.ok || mode === "screenshot") return shot.ok ? { ...shot, artifactPath: output } : shot;
  if (!available("tesseract")) return unavailable("vision OCR", `Screenshot saved to ${output}; install tesseract for OCR.`);
  return runExternal("tesseract", [output, "stdout"], { feature: "vision OCR", timeoutMs: 60_000 });
}

export async function window(action) {
  const args = splitArgs(action);
  const verb = (args.shift() || "list").toLowerCase();
  const target = args.join(" ");
  if (verb === "list" || verb === "windows") {
    return runPowerShell(`Get-Process | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Depth 3`, { feature: "window" });
  }
  if (verb === "activate" && target) {
    return runPowerShell(`$ws=New-Object -ComObject WScript.Shell; if(-not $ws.AppActivate(${psQuote(target)})){throw 'window not found'}; 'activated'`, { feature: "window" });
  }
  if (["minimize", "maximize", "restore", "close"].includes(verb) && target) {
    const code = { minimize: 6, maximize: 3, restore: 9, close: 0 }[verb];
    const operation = verb === "close" ? "[Win]::PostMessage($p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)" : `[Win]::ShowWindowAsync($p.MainWindowHandle,${code})`;
    return runPowerShell(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int n); [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }'; $p=Get-Process | Where-Object {$_.ProcessName -like ${psQuote(`*${target}*`)} -or $_.MainWindowTitle -like ${psQuote(`*${target}*`)}} | Select-Object -First 1; if(-not $p){throw 'window not found'}; ${operation} | Out-Null; '${verb} requested'`, { feature: "window" });
  }
  return unavailable("window action", "Supported Windows actions: list, activate <title>, minimize|maximize|restore|close <process/title>.");
}

export async function clipboard({ mode, text }) {
  return mode === "read"
    ? runPowerShell("Get-Clipboard -Raw", { feature: "clipboard" })
    : runPowerShell(`Set-Clipboard -Value ${psQuote(text)}; 'clipboard updated'`, { feature: "clipboard" });
}

export async function notification({ title, body = "" }) {
  return runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle=${psQuote(title)}; $n.BalloonTipText=${psQuote(body)}; $n.Visible=$true; $n.ShowBalloonTip(3000); Start-Sleep -Seconds 4; $n.Dispose(); 'notification posted'`, { feature: "notification", timeoutMs: 10_000 });
}

export async function fileDialog({ mode = "open", prompt = "Choose a file" } = {}) {
  const klass = mode === "save" ? "SaveFileDialog" : "OpenFileDialog";
  return runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.${klass}; $d.Title=${psQuote(prompt)}; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){$d.FileName}else{throw 'dialog cancelled'}`, { feature: "file dialog", timeoutMs: 120_000 });
}

export async function screenRecord({ action, seconds = 8 }) {
  if (action === "stop") return stopCapture("screen-record");
  if (!available("ffmpeg")) return unavailable("screen_record", "Install ffmpeg.");
  const output = capturePath("screen", "mp4");
  return startCapture("screen-record", ["ffmpeg", "-y", "-f", "gdigrab", "-framerate", "30", "-i", "desktop", "-t", String(seconds), "-pix_fmt", "yuv420p", output], output);
}

export async function audio({ action, path: filePath, seconds = 5 }) {
  if (action === "play") {
    if (!filePath) return { ok: false, code: null, stdout: "", stderr: "path is required for play" };
    if (available("ffplay")) return runExternal("ffplay", ["-nodisp", "-autoexit", filePath], { feature: "audio playback", timeoutMs: 60_000 });
    if (!filePath.toLowerCase().endsWith(".wav")) return unavailable("audio playback", "Install ffplay for non-WAV files.");
    return runPowerShell(`$p=New-Object System.Media.SoundPlayer ${psQuote(filePath)}; $p.PlaySync(); 'played'`, { feature: "audio playback", timeoutMs: 60_000 });
  }
  const output = capturePath("mic", "wav");
  const device = process.env.WINDOWS_AUDIO_DEVICE || "audio=default";
  const result = await runExternal("ffmpeg", ["-y", "-f", "dshow", "-i", device, "-t", String(seconds), output], { feature: "audio recording", timeoutMs: (seconds + 10) * 1_000, maxStderr: 4_000 });
  return result.ok ? { ...result, stdout: output } : result;
}

export async function scheduler({ action, label, command, intervalSeconds = 3_600 }) {
  if (action === "list") return runCommand(["schtasks.exe", "/Query", "/FO", "CSV", "/V"], { shell: false, timeoutMs: 30_000 });
  if (!validLabel(label) || !command) return { ok: false, code: null, stdout: "", stderr: "label and command are required; label must use letters, digits, dots, underscores, or hyphens" };
  const minutes = Math.max(1, Math.ceil(intervalSeconds / 60));
  return runCommand(["schtasks.exe", "/Create", "/F", "/SC", "MINUTE", "/MO", String(minutes), "/TN", label, "/TR", command], { shell: false, timeoutMs: 30_000 });
}

export async function systemInfo() {
  return runPowerShell("Get-ComputerInfo | Select-Object OsName,OsVersion,CsName,CsManufacturer,CsModel,CsTotalPhysicalMemory,CsNumberOfLogicalProcessors | Format-List | Out-String", { feature: "system info", timeoutMs: 30_000 });
}

export async function healthInfo() {
  return runPowerShell("Get-CimInstance Win32_OperatingSystem | Select-Object FreePhysicalMemory,TotalVisibleMemorySize,LastBootUpTime | Format-List; Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free,Used | Format-Table | Out-String", { feature: "health", timeoutMs: 30_000 });
}

function validLabel(label) {
  return typeof label === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(label);
}
