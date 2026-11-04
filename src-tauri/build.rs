fn main() {
    let mut attrs = tauri_build::Attributes::new();
    // В релизной сборке программа всегда просит права администратора — без них TUN не создать.
    // В режиме разработки манифест не встраиваем, чтобы `tauri dev` запускался без UAC.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        attrs = attrs.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("app.manifest")),
        );
    }
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
