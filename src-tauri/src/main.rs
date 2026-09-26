// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // No arguments: the GUI, exactly as before.
    if args.len() <= 1 {
        grove_lib::run();
        return;
    }

    // macOS Finder passes `-psn_<pid>` on legacy launches; treat it as no
    // argument at all. On Windows and Linux a `grove://` link arrives as the
    // first argument; the GUI (and its single-instance handoff) takes it.
    if args[1].starts_with("-psn_") || args[1].starts_with("grove://") {
        grove_lib::run();
        return;
    }

    match args[1].as_str() {
        "help" | "--help" | "-h" => {
            print!("{}", grove_lib::cli::USAGE);
        }
        "version" | "--version" => {
            println!("grove {}", env!("CARGO_PKG_VERSION"));
        }
        subcommand => {
            let code = match grove_lib::cli::run(&args[1..]) {
                Ok(code) => code,
                Err(error) => {
                    eprintln!("grove {subcommand}: {error}");
                    error.exit_code()
                }
            };
            std::process::exit(code);
        }
    }
}
