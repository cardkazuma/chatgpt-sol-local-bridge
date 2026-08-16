# Platform backends

All 44 MCP tools are always registered. Platform-dependent tools return a capability-unavailable error when their required backend is absent; `npm run doctor` reports each capability.

## macOS

- Native application tools use `interceptor macos`.
- Fallbacks: `pbcopy`/`pbpaste`, `osascript`, `screencapture`.
- Capture/audio uses ffmpeg avfoundation and `afplay`.
- Scheduling uses per-user LaunchAgents.
- Grant Accessibility, Screen Recording, and Microphone permissions to the actual Terminal/Node/interceptor executables.

## Linux

- X11 input/accessibility uses `xdotool`; windows use `wmctrl`.
- Wayland screenshot uses `grim`; clipboard uses wl-clipboard.
- X11 screenshot fallbacks: gnome-screenshot, scrot, ImageMagick import.
- OCR uses Tesseract; dialogs use zenity/kdialog; notifications use notify-send.
- Capture/audio uses ffmpeg X11/PulseAudio.
- Scheduling uses systemd user timers.

Wayland compositors deliberately restrict global input and window management. Some actions may be unavailable even with dependencies installed. Prefer browser automation or portal-supported workflows.

## Windows

- Native accessibility uses Windows UI Automation through PowerShell.
- Input/window operations use WinForms/Win32.
- Screenshot and dialogs use System.Drawing/WinForms.
- Clipboard and notifications use PowerShell/WinForms.
- Capture uses ffmpeg gdigrab/dshow; OCR uses Tesseract.
- Scheduling uses Task Scheduler.

Supported compatibility grammar:

```text
accessibility: apps | find <name> | click <name> | type <text>
input_event:  keys <SendKeys expression> | click X Y | scroll DELTA
window:       list | activate <title> | minimize|maximize|restore|close <title>
```

Windows automation must run in an interactive user session; Session 0 services cannot operate the user's desktop.

## Office documents

DOCX/XLSX reading and writing is implemented in Node and works on all platforms. It handles document text and workbook cell data, but does not execute macros, reproduce rendering exactly, or recalculate Excel formulas like a full Office installation.
