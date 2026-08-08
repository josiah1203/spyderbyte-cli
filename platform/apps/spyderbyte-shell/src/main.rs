#![forbid(unsafe_code)]

use std::env;
use std::io;

fn main() -> io::Result<()> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
    {
        println!("{}", spyderbyte_shell::help_text());
        return Ok(());
    }
    if args.iter().any(|arg| arg == "--version") {
        println!("spyderbyte 0.0.0");
        return Ok(());
    }
    spyderbyte_shell::terminal::run(&args)
}
