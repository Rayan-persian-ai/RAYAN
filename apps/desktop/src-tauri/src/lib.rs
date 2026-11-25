//! RAYAN desktop shell: a thin Tauri v2 window around the bundled web app.
//! All product logic lives in apps/web; the shell adds no native commands,
//! so the web code gets no extra privileges beyond a normal browser tab.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running RAYAN desktop shell");
}
