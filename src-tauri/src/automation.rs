//! Debug-build desktop automation: a unix socket that lets a script drive the real
//! app (real IPC, real watcher, real WKWebView) the way a person would.
//!
//! Compiled only with `debug_assertions`; a release binary has no socket and no
//! trace of this module. It is active only when `GROVE_AUTOMATION_SOCKET=<path>` is
//! set at launch, and then the app is invisible by construction: the activation
//! policy is `Prohibited` before the event loop starts (no Dock icon, never active or
//! frontmost), the window-state plugin (which shows and focuses) is not registered,
//! and the window is created hidden, then ordered in behind other windows fully
//! transparent, click-through, and out of Exposé, so WebKit keeps rendering.
//!
//! Requests and responses are newline-delimited JSON:
//!
//! - `{"id","op":"eval","js"}` runs `js` as the body of an async function in the
//!   main webview and returns its JSON value.
//! - `{"id","op":"invoke","command","args"}` calls a registered command through the
//!   webview's own IPC, so it passes the same capability checks as the UI.
//! - `{"id","op":"screenshot","path"}` writes a PNG rendered in-process by WebKit
//!   (`takeSnapshotWithConfiguration`); nothing is captured from the screen.
//! - `{"id","op":"presence"}` reports `windowVisible` and `appActive`, so a run can
//!   prove the app never appeared.
//! - `{"id","op":"quit"}` exits the app.
//!
//! Every response is `{"id","ok":true,"value"}` or `{"id","ok":false,"error"}`.
//! The bridge reads the UI and renders pixels; it never writes a repository file.
//!
//! Failure modes, each reported as an error response rather than a hang:
//! - the webview never answers (navigation, a thrown error before the promise, a
//!   reload): the eval times out after 10 s;
//! - the main window does not exist yet: `window "main" not found`;
//! - WebKit returns no image for the hidden view: `snapshot produced no image`,
//!   and the harness records a DOM snapshot instead;
//! - the socket path is taken by a stale file: it is removed before binding.

use std::collections::HashMap;
use std::ffi::c_void;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{ActivationPolicy, App, AppHandle, Context, Listener, Manager, Runtime, WebviewWindow};

const SOCKET_ENV: &str = "GROVE_AUTOMATION_SOCKET";
const RESULT_EVENT: &str = "grove://automation-result";
/// How often a waiting eval re-reads its result slot in the page.
const POLL_SLICE: Duration = Duration::from_millis(500);
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);
/// `NSBitmapImageFileTypePNG`.
const PNG_FILE_TYPE: usize = 4;
/// `NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorIgnoresCycle`:
/// hidden from Mission Control and Exposé, skipped by ⌘`.
const OUT_OF_EXPOSE: usize = (1 << 3) | (1 << 6);

/// Whether this launch is driven by the automation socket.
pub fn requested() -> bool {
    std::env::var_os(SOCKET_ENV).is_some_and(|value| !value.is_empty())
}

/// Makes every configured window start hidden and unfocused, before any is built.
pub fn hide_windows<R: Runtime>(context: &mut Context<R>) {
    if !requested() {
        return;
    }
    for window in &mut context.config_mut().app.windows {
        window.visible = false;
        window.focus = false;
    }
}

/// Applied by tao at launch, before its activate call: no Dock icon, never frontmost.
pub fn prohibit_activation<R: Runtime>(app: &mut App<R>) {
    if requested() {
        app.set_activation_policy(ActivationPolicy::Prohibited);
    }
}

/// Eval ids waiting for the webview to post their result back.
type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<Value>>>>;

#[derive(Deserialize)]
struct Envelope {
    id: String,
    #[serde(flatten)]
    request: Request,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Eval {
        js: String,
    },
    Invoke {
        command: String,
        #[serde(default)]
        args: Value,
    },
    Screenshot {
        path: String,
    },
    Presence,
    Quit,
}

/// Starts the bridge when the socket variable is set; otherwise does nothing.
pub fn install<R: Runtime>(app: &App<R>) {
    let Some(socket) = std::env::var_os(SOCKET_ENV).filter(|value| !value.is_empty()) else {
        return;
    };
    let _ = std::fs::remove_file(&socket);
    if let Err(error) = order_in_transparent(app) {
        eprintln!("automation: {error}");
    }
    let listener = match UnixListener::bind(&socket) {
        Ok(listener) => listener,
        Err(error) => return eprintln!("automation: {}: {error}", socket.to_string_lossy()),
    };
    let pending: Pending = Arc::default();
    let results = pending.clone();
    app.listen_any(RESULT_EVENT, move |event| {
        deliver_result(&results, event.payload())
    });
    let handle = app.handle().clone();
    std::thread::spawn(move || accept_loop(listener, handle, pending));
    eprintln!("automation: listening on {}", socket.to_string_lossy());
}

/// Orders the hidden main window in, fully transparent, click-through, behind other
/// windows and out of Exposé, without making it key or activating the app. WebKit
/// runs requestAnimationFrame only for a page it considers visible, and the diff
/// view renders through rAF, so a never-shown window would never draw a diff.
fn order_in_transparent<R: Runtime>(app: &App<R>) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "window \"main\" not found".to_string())?;
    let ns_window = window
        .ns_window()
        .map_err(|error| error.to_string())?
        .cast::<AnyObject>();
    let nothing: *mut AnyObject = std::ptr::null_mut();
    // SAFETY: the live NSWindow of the main window, configured on the main thread
    // (the setup hook runs there) with plain AppKit setters.
    unsafe {
        let _: () = msg_send![ns_window, setAlphaValue: 0.0_f64];
        let _: () = msg_send![ns_window, setIgnoresMouseEvents: true];
        let _: () = msg_send![ns_window, setHasShadow: false];
        let _: () = msg_send![ns_window, setCollectionBehavior: OUT_OF_EXPOSE];
        let _: () = msg_send![ns_window, setExcludedFromWindowsMenu: true];
        let _: () = msg_send![ns_window, orderBack: nothing];
    }
    window
        .with_webview(|webview| keep_page_visible(webview.inner()))
        .map_err(|error| error.to_string())
}

/// Turns off WKWebView's window-occlusion detection, so a transparent window behind
/// others still counts as visible to WebKit (timers and rAF unthrottled).
fn keep_page_visible(webview: *mut c_void) {
    let webview = webview.cast::<AnyObject>();
    let selector = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
    // SAFETY: the live WKWebView on the main thread; the private setter is only sent
    // after `respondsToSelector:` confirms it exists.
    unsafe {
        let responds: bool = msg_send![webview, respondsToSelector: selector];
        if !responds {
            return eprintln!("automation: WKWebView has no occlusion-detection setter");
        }
        let _: () = msg_send![webview, _setWindowOcclusionDetectionEnabled: false];
    }
}

/// Routes a posted eval result to the request waiting on its id.
fn deliver_result(pending: &Pending, payload: &str) {
    let Ok(result) = serde_json::from_str::<Value>(payload) else {
        return eprintln!("automation: unreadable result payload");
    };
    let id = result["id"].as_str().unwrap_or_default().to_string();
    let waiter = waiting(pending).remove(&id);
    if let Some(sender) = waiter {
        let _ = sender.send(result);
    }
}

fn waiting(pending: &Pending) -> std::sync::MutexGuard<'_, HashMap<String, mpsc::Sender<Value>>> {
    pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn accept_loop<R: Runtime>(listener: UnixListener, app: AppHandle<R>, pending: Pending) {
    for stream in listener.incoming().flatten() {
        let app = app.clone();
        let pending = pending.clone();
        std::thread::spawn(move || serve(stream, app, pending));
    }
}

/// Answers each request line on one connection, in order.
fn serve<R: Runtime>(stream: UnixStream, app: AppHandle<R>, pending: Pending) {
    let Ok(mut writer) = stream.try_clone() else {
        return;
    };
    for line in BufReader::new(stream).lines().map_while(Result::ok) {
        let response = match serde_json::from_str::<Envelope>(&line) {
            Ok(envelope) => respond(&app, &pending, envelope),
            Err(error) => json!({ "id": Value::Null, "ok": false, "error": error.to_string() }),
        };
        if writeln!(writer, "{response}").is_err() {
            return;
        }
    }
}

fn respond<R: Runtime>(app: &AppHandle<R>, pending: &Pending, envelope: Envelope) -> Value {
    let id = envelope.id;
    let outcome = match envelope.request {
        Request::Eval { js } => evaluate(app, pending, &id, &js),
        Request::Invoke { command, args } => {
            evaluate(app, pending, &id, &invoke_script(&command, &args))
        }
        Request::Screenshot { path } => screenshot(app, &path).map(|()| json!(path)),
        Request::Presence => presence(app),
        Request::Quit => Ok(exit_after_reply(app)),
    };
    match outcome {
        Ok(value) => json!({ "id": id, "ok": true, "value": value }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    }
}

/// Exits shortly after the reply is written, so the client sees its answer.
fn exit_after_reply<R: Runtime>(app: &AppHandle<R>) -> Value {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        app.exit(0);
    });
    Value::Null
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "window \"main\" not found".to_string())
}

/// Runs `body` as an async function in the webview. The page stores the settled
/// value in a per-id slot and also posts it back as an event; the event is the fast
/// path, and the slot is re-read while waiting, so a dropped IPC message cannot
/// lose a completed eval.
fn evaluate<R: Runtime>(
    app: &AppHandle<R>,
    pending: &Pending,
    id: &str,
    body: &str,
) -> Result<Value, String> {
    let window = main_window(app)?;
    let (sender, receiver) = mpsc::channel();
    waiting(pending).insert(id.to_string(), sender);
    let result = window
        .eval(eval_script(id, body))
        .map_err(|error| error.to_string())
        .and_then(|()| await_result(&window, &receiver, id));
    waiting(pending).remove(id);
    let _ = window.eval(format!(
        "delete (window.__groveAutomationResults || {{}})[{}];",
        json!(id)
    ));
    let result = result?;
    match result["ok"].as_bool() {
        Some(true) => Ok(result["value"].clone()),
        _ => Err(result["error"]
            .as_str()
            .unwrap_or("eval failed")
            .to_string()),
    }
}

fn await_result<R: Runtime>(
    window: &WebviewWindow<R>,
    receiver: &mpsc::Receiver<Value>,
    id: &str,
) -> Result<Value, String> {
    let deadline = std::time::Instant::now() + EVAL_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if let Ok(result) = receiver.recv_timeout(POLL_SLICE) {
            return Ok(result);
        }
        if let Some(result) = read_page(
            window,
            &format!("(window.__groveAutomationResults || {{}})[{}]", json!(id)),
        ) {
            return Ok(result);
        }
    }
    let trace = read_page(window, "window.__groveAutomationTrace").unwrap_or(Value::Null);
    Err(format!(
        "eval timed out after {} s; last page trace: {trace}",
        EVAL_TIMEOUT.as_secs()
    ))
}

/// Reads one JSON-serializable page value synchronously; `None` when absent or unreadable.
fn read_page<R: Runtime>(window: &WebviewWindow<R>, expression: &str) -> Option<Value> {
    let (sender, receiver) = mpsc::channel();
    let script = format!("JSON.stringify({expression} ?? null)");
    window
        .eval_with_callback(script, move |raw| {
            let _ = sender.send(raw);
        })
        .ok()?;
    let raw = receiver.recv_timeout(POLL_SLICE).ok()?;
    // WebKit hands back the string result JSON-encoded, so it may need a second decode.
    let value = match serde_json::from_str::<Value>(&raw).ok()? {
        Value::String(inner) => serde_json::from_str(&inner).ok()?,
        other => other,
    };
    (!value.is_null()).then_some(value)
}

fn eval_script(id: &str, body: &str) -> String {
    let id = json!(id);
    let event = json!(RESULT_EVENT);
    format!(
        "(async () => {{\n\
         const trace = (phase) => {{ window.__groveAutomationTrace = {{ id: {id}, phase, at: Date.now() }}; }};\n\
         const settle = async (payload) => {{\n\
         (window.__groveAutomationResults ||= {{}})[{id}] = payload;\n\
         trace(payload.ok ? 'settled' : 'failed');\n\
         try {{ await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{ event: {event}, payload }}); trace('posted'); }}\n\
         catch (error) {{ trace('post failed: ' + error); }}\n\
         }};\n\
         trace('running');\n\
         let payload;\n\
         try {{\n\
         const value = await (async () => {{\n{body}\n}})();\n\
         payload = JSON.parse(JSON.stringify({{ id: {id}, ok: true, value: value === undefined ? null : value }}));\n\
         }} catch (error) {{\n\
         payload = {{ id: {id}, ok: false, error: `${{error}}\\n${{(error && error.stack) || ''}}` }};\n\
         }}\n\
         await settle(payload);\n\
         }})();"
    )
}

fn invoke_script(command: &str, args: &Value) -> String {
    let args = if args.is_null() {
        json!({})
    } else {
        args.clone()
    };
    format!(
        "return await window.__TAURI_INTERNALS__.invoke({}, {args});",
        json!(command)
    )
}

type Snapshot = Result<Vec<u8>, String>;

/// Renders the webview to a PNG in-process; the window never has to be on screen.
fn screenshot<R: Runtime>(app: &AppHandle<R>, path: &str) -> Result<(), String> {
    let window = main_window(app)?;
    let (sender, receiver) = mpsc::channel::<Snapshot>();
    window
        .with_webview(move |webview| request_snapshot(webview.inner(), sender))
        .map_err(|error| error.to_string())?;
    let png = receiver
        .recv_timeout(EVAL_TIMEOUT)
        .map_err(|_| format!("snapshot timed out after {} s", EVAL_TIMEOUT.as_secs()))??;
    std::fs::write(path, png).map_err(|error| format!("{path}: {error}"))
}

/// Asks WebKit for a snapshot; the completion handler runs later on the main thread.
fn request_snapshot(webview: *mut c_void, sender: mpsc::Sender<Snapshot>) {
    let handler = block2::RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
        let _ = sender.send(png_bytes(image));
    });
    let configuration: *mut AnyObject = std::ptr::null_mut();
    // SAFETY: `webview` is the live WKWebView handed over by `with_webview` on the main thread.
    unsafe {
        let webview = webview.cast::<AnyObject>();
        let _: () = msg_send![webview, takeSnapshotWithConfiguration: configuration, completionHandler: &*handler];
    }
}

/// Encodes an `NSImage` as PNG bytes through `NSBitmapImageRep`.
fn png_bytes(image: *mut AnyObject) -> Snapshot {
    if image.is_null() {
        return Err("snapshot produced no image".to_string());
    }
    // SAFETY: plain Foundation/AppKit getters on a non-null NSImage, on the main thread;
    // every returned object is autoreleased and outlives this call.
    unsafe {
        let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
        let bitmap: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
        let properties: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
        let png: *mut AnyObject =
            msg_send![bitmap, representationUsingType: PNG_FILE_TYPE, properties: properties];
        if png.is_null() {
            return Err("snapshot could not be encoded as PNG".to_string());
        }
        let length: usize = msg_send![png, length];
        let bytes: *const c_void = msg_send![png, bytes];
        Ok(std::slice::from_raw_parts(bytes.cast::<u8>(), length).to_vec())
    }
}

/// How the main window and the app present to the user, read on the main thread,
/// so a run can prove nothing appeared: window alpha, key status, whether the app
/// is active, and whether the window server lists the window as on screen.
fn presence<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    let window = main_window(app)?;
    let (sender, receiver) = mpsc::channel();
    app.run_on_main_thread(move || {
        let report = window
            .ns_window()
            .map(|pointer| window_presence(pointer.cast::<AnyObject>()))
            .map_err(|error| error.to_string());
        let _ = sender.send(report);
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(EVAL_TIMEOUT)
        .map_err(|_| "the main thread did not report presence".to_string())?
}

fn window_presence(ns_window: *mut AnyObject) -> Value {
    // SAFETY: AppKit getters on the live NSWindow and the shared NSApplication, on
    // the main thread.
    let (alpha, key, number, active) = unsafe {
        let shared: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let alpha: f64 = msg_send![ns_window, alphaValue];
        let key: bool = msg_send![ns_window, isKeyWindow];
        let number: isize = msg_send![ns_window, windowNumber];
        let active: bool = msg_send![shared, isActive];
        (alpha, key, number, active)
    };
    json!({
        "alpha": alpha,
        "keyWindow": key,
        "appActive": active,
        "listedOnScreen": listed_on_screen(number),
    })
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> *mut AnyObject;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: *const c_void);
}

/// `kCGWindowListOptionOnScreenOnly`.
const ON_SCREEN_ONLY: u32 = 1;

/// Whether `CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly)` lists the window.
fn listed_on_screen(window_number: isize) -> bool {
    // SAFETY: the returned CFArray of CFDictionaries is toll-free bridged to
    // NSArray/NSDictionary, read here and released once.
    unsafe {
        let windows = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, 0);
        if windows.is_null() {
            return false;
        }
        let key: *mut AnyObject =
            msg_send![class!(NSString), stringWithUTF8String: c"kCGWindowNumber".as_ptr()];
        let count: usize = msg_send![windows, count];
        let listed = (0..count).any(|index| {
            let info: *mut AnyObject = msg_send![windows, objectAtIndex: index];
            let number: *mut AnyObject = msg_send![info, objectForKey: key];
            !number.is_null() && {
                let value: isize = msg_send![number, integerValue];
                value == window_number
            }
        });
        CFRelease(windows.cast::<c_void>().cast_const());
        listed
    }
}
