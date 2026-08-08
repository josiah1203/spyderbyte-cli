use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=SPYDERBYTE_MELTANO_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=SPYDERBYTE_UPDATE_ENDPOINT");
    println!("cargo:rerun-if-env-changed=SPYDERBYTE_BRIDGE_PUBLIC_KEY");
    if env::var("AGENTIC_RELEASE_BUILD").as_deref() == Ok("true") {
        for variable in ["AGENTIC_LICENSE_PUBLIC_KEY", "AGENTIC_LICENSE_KEY_ID"] {
            if env::var(variable).map_or(true, |value| value.trim().is_empty()) {
                panic!("{variable} is required for an embedded-key Spyderbyte release build");
            }
        }
    }
    tauri_build::build()
}
