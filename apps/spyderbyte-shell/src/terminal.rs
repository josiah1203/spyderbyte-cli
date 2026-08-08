use crate::{Action, Key, ShellEvent, ShellState};
use std::env;
use std::io::{self, BufRead, BufReader, IsTerminal, Read, Write};
use std::net::TcpStream;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

pub fn run(args: &[String]) -> io::Result<()> {
    let workspace = option(args, "--workspace")
        .or_else(|| env::var("SPYDERBYTE_WORKSPACE").ok())
        .unwrap_or_else(|| "current workspace".to_string());
    let project = option(args, "--project")
        .or_else(|| env::var("SPYDERBYTE_PROJECT").ok())
        .unwrap_or_else(|| "no project selected".to_string());
    let model = env::var("SPYDERBYTE_MODEL").unwrap_or_else(|_| "backend selection".to_string());
    let mut state = if args.iter().any(|arg| arg == "--demo") {
        crate::demo_state()
    } else {
        ShellState::new(workspace, project, model)
    };
    if args.iter().any(|arg| arg == "--narrow") {
        state.set_layout(crate::LayoutMode::Narrow);
    }
    let plain = args.iter().any(|arg| arg == "--plain")
        || !io::stdin().is_terminal()
        || !io::stdout().is_terminal()
        || cfg!(windows);
    if let Some(bridge) = connect_bridge()? {
        return run_bridged(&mut state, bridge, plain);
    }
    if plain {
        return run_plain(&mut state);
    }
    run_interactive(&mut state)
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| pair[1].clone())
}

fn run_plain(state: &mut ShellState) -> io::Result<()> {
    println!("{}", state.render(100, 40));
    println!("\nSpyderbyte plain mode — type a request, or type quit to exit.");
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if matches!(line.trim(), "quit" | "exit") {
            break;
        }
        for character in line.chars() {
            let _ = state.handle_key(Key::Character(character));
        }
        let action = state.handle_key(Key::Enter);
        if let Action::Submit(text) = action {
            state.apply_event(ShellEvent::Log {
                level: "client".to_string(),
                message: format!("draft received ({})", text.lines().count()),
            });
        }
        println!("\n{}", state.render(100, 40));
    }
    Ok(())
}

#[cfg(unix)]
fn run_interactive(state: &mut ShellState) -> io::Result<()> {
    let _terminal = RawTerminal::enter()?;
    let mut stdout = io::stdout();
    stdout.write_all(b"\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H")?;
    stdout.flush()?;
    let mut stdin = io::stdin();
    loop {
        let (width, height) = terminal_size();
        stdout.write_all(b"\x1b[2J\x1b[H")?;
        stdout.write_all(state.render(width, height).as_bytes())?;
        stdout.flush()?;
        match read_key(&mut stdin)? {
            Key::Ctrl('c') | Key::Ctrl('q') => break,
            key => {
                let action = state.handle_key(key);
                if matches!(action, Action::Quit) {
                    break;
                }
                if let Action::Submit(text) = action {
                    state.apply_event(ShellEvent::Log {
                        level: "client".to_string(),
                        message: format!("draft received ({})", text.lines().count()),
                    });
                }
            }
        }
    }
    stdout.write_all(b"\x1b[?25h\x1b[?1049l")?;
    stdout.flush()
}

#[cfg(not(unix))]
fn run_interactive(state: &mut ShellState) -> io::Result<()> {
    run_plain(state)
}

#[derive(Debug, Eq, PartialEq)]
enum BridgeMessage {
    Context {
        workspace: String,
        project: String,
        model: String,
    },
    Event(ShellEvent),
    Closed,
}

struct Bridge {
    writer: TcpStream,
    messages: Receiver<BridgeMessage>,
}

fn connect_bridge() -> io::Result<Option<Bridge>> {
    let Some(specification) = env::var_os("SPYDERBYTE_SHELL_BRIDGE") else {
        return Ok(None);
    };
    let specification = specification.to_string_lossy();
    let mut parts = specification.splitn(3, ':');
    let host = parts.next().unwrap_or_default();
    let port = parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bridge port is missing"))?
        .parse::<u16>()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bridge port is invalid"))?;
    let token = parts
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "bridge token is missing"))?;
    let address = format!("{host}:{port}");
    let mut connection = None;
    for attempt in 0..40 {
        match TcpStream::connect(&address) {
            Ok(stream) => {
                connection = Some(stream);
                break;
            }
            Err(error) if attempt < 39 => {
                let _ = error;
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => return Err(error),
        }
    }
    let mut writer = connection.ok_or_else(|| io::Error::other("bridge connection failed"))?;
    write_bridge_frame(&mut writer, "HELLO", &[token])?;
    let reader = writer.try_clone()?;
    let (sender, messages) = mpsc::channel();
    thread::spawn(move || bridge_reader(reader, sender));
    Ok(Some(Bridge { writer, messages }))
}

fn bridge_reader(stream: TcpStream, sender: Sender<BridgeMessage>) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Some(message) = parse_bridge_frame(line.trim_end()) {
                    if sender.send(message).is_err() {
                        return;
                    }
                }
            }
        }
    }
    let _ = sender.send(BridgeMessage::Closed);
}

fn run_bridged(state: &mut ShellState, mut bridge: Bridge, plain: bool) -> io::Result<()> {
    if plain {
        return run_bridged_loop(state, &mut bridge, true);
    }
    #[cfg(unix)]
    {
        let _terminal = RawTerminal::enter()?;
        let mut stdout = io::stdout();
        stdout.write_all(b"\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H")?;
        stdout.flush()?;
        let result = run_bridged_loop(state, &mut bridge, false);
        stdout.write_all(b"\x1b[?25h\x1b[?1049l")?;
        stdout.flush()?;
        return result;
    }
    #[cfg(not(unix))]
    {
        run_bridged_loop(state, &mut bridge, true)
    }
}

fn run_bridged_loop(state: &mut ShellState, bridge: &mut Bridge, plain: bool) -> io::Result<()> {
    let (sender, input) = mpsc::channel();
    let (_, empty_receiver) = mpsc::channel();
    let bridge_messages = std::mem::replace(&mut bridge.messages, empty_receiver);
    let bridge_sender = sender.clone();
    thread::spawn(move || {
        for message in bridge_messages {
            if bridge_sender.send(InputMessage::Bridge(message)).is_err() {
                return;
            }
        }
    });
    spawn_input_reader(sender.clone(), plain);
    let mut redraw = true;
    if plain {
        println!("{}", state.render(100, 40));
        println!("\nSpyderbyte plain mode — type a request, or type quit to exit.");
    }
    loop {
        if redraw && !plain {
            let (width, height) = terminal_size();
            let mut stdout = io::stdout();
            stdout.write_all(b"\x1b[2J\x1b[H")?;
            stdout.write_all(state.render(width, height).as_bytes())?;
            stdout.flush()?;
            redraw = false;
        } else if redraw {
            println!("\n{}", state.render(100, 40));
            redraw = false;
        }
        match input.recv_timeout(Duration::from_millis(100)) {
            Ok(InputMessage::Bridge(message)) => match message {
                BridgeMessage::Context {
                    workspace,
                    project,
                    model,
                } => {
                    state.set_context(workspace, project, model);
                    redraw = true;
                }
                BridgeMessage::Event(event) => {
                    state.apply_event(event);
                    redraw = true;
                }
                BridgeMessage::Closed => {
                    state.apply_event(ShellEvent::Connection {
                        state: "disconnected".to_string(),
                    });
                    break;
                }
            },
            Ok(InputMessage::Line(line)) => {
                if matches!(line.trim(), "quit" | "exit") {
                    write_bridge_frame(&mut bridge.writer, "QUIT", &[])?;
                    break;
                }
                for character in line.chars() {
                    let _ = state.handle_key(Key::Character(character));
                }
                if let Action::Submit(text) = state.handle_key(Key::Enter) {
                    write_bridge_frame(&mut bridge.writer, "SUBMIT", &[&text])?;
                }
                redraw = true;
            }
            Ok(InputMessage::Key(key)) => {
                if key == Key::Ctrl('c') {
                    let _ = write_bridge_frame(&mut bridge.writer, "CANCEL", &[]);
                    let _ = write_bridge_frame(&mut bridge.writer, "QUIT", &[]);
                    break;
                }
                if key == Key::Ctrl('q') {
                    let _ = write_bridge_frame(&mut bridge.writer, "QUIT", &[]);
                    break;
                }
                if let Action::Submit(text) = state.handle_key(key) {
                    write_bridge_frame(&mut bridge.writer, "SUBMIT", &[&text])?;
                }
                redraw = true;
            }
            Ok(InputMessage::Closed) => {
                let _ = write_bridge_frame(&mut bridge.writer, "QUIT", &[]);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

enum InputMessage {
    Bridge(BridgeMessage),
    Key(Key),
    Line(String),
    Closed,
}

fn spawn_input_reader(sender: Sender<InputMessage>, plain: bool) {
    if plain {
        thread::spawn(move || {
            let stdin = io::stdin();
            for line in stdin.lock().lines() {
                match line {
                    Ok(line) => {
                        if sender.send(InputMessage::Line(line)).is_err() {
                            return;
                        }
                    }
                    Err(_) => break,
                }
            }
            let _ = sender.send(InputMessage::Closed);
        });
        return;
    }
    #[cfg(unix)]
    thread::spawn(move || {
        let mut stdin = io::stdin();
        loop {
            match read_key(&mut stdin) {
                Ok(key) if sender.send(InputMessage::Key(key)).is_err() => return,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = sender.send(InputMessage::Closed);
    });
    #[cfg(not(unix))]
    {
        let _ = sender.send(InputMessage::Closed);
    }
}

fn write_bridge_frame(stream: &mut impl Write, command: &str, fields: &[&str]) -> io::Result<()> {
    let mut frame = command.to_string();
    for field in fields {
        frame.push('\t');
        frame.push_str(&hex_encode(field.as_bytes()));
    }
    frame.push('\n');
    stream.write_all(frame.as_bytes())?;
    stream.flush()
}

fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[usize::from(byte >> 4)] as char);
        output.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    output
}

fn hex_decode(value: &str) -> Option<String> {
    if value.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for pair in value.as_bytes().chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16)? as u8;
        let low = (pair[1] as char).to_digit(16)? as u8;
        bytes.push((high << 4) | low);
    }
    String::from_utf8(bytes).ok()
}

fn parse_bridge_frame(line: &str) -> Option<BridgeMessage> {
    let mut fields = line.split('\t');
    let command = fields.next()?;
    let value = |field: Option<&str>| field.and_then(hex_decode);
    match command {
        "CONTEXT" => Some(BridgeMessage::Context {
            workspace: value(fields.next())?,
            project: value(fields.next())?,
            model: value(fields.next())?,
        }),
        "DELTA" => Some(BridgeMessage::Event(ShellEvent::AssistantDelta(value(
            fields.next(),
        )?))),
        "MESSAGE" => Some(BridgeMessage::Event(ShellEvent::AssistantMessage(value(
            fields.next(),
        )?))),
        "PLAN" => Some(BridgeMessage::Event(ShellEvent::Plan {
            title: value(fields.next())?,
            steps: value(fields.next())?
                .split('\u{1f}')
                .map(str::to_string)
                .collect(),
        })),
        "APPROVAL" => Some(BridgeMessage::Event(ShellEvent::ApprovalRequired {
            title: value(fields.next())?,
            summary: value(fields.next())?,
        })),
        "STATUS" => Some(BridgeMessage::Event(ShellEvent::RunStatus {
            state: value(fields.next())?,
            detail: value(fields.next())?,
        })),
        "LOG" => Some(BridgeMessage::Event(ShellEvent::Log {
            level: value(fields.next())?,
            message: value(fields.next())?,
        })),
        "CONNECTION" => Some(BridgeMessage::Event(ShellEvent::Connection {
            state: value(fields.next())?,
        })),
        _ => None,
    }
}

#[cfg(unix)]
struct RawTerminal {
    settings: String,
}

#[cfg(unix)]
impl RawTerminal {
    fn enter() -> io::Result<Self> {
        let saved = Command::new("stty")
            .arg("-g")
            .stdin(Stdio::inherit())
            .output()?;
        if !saved.status.success() {
            return Err(io::Error::other("unable to read terminal settings"));
        }
        let settings = String::from_utf8_lossy(&saved.stdout).trim().to_string();
        let configured = Command::new("stty")
            .args([
                "-icanon", "-echo", "-isig", "-ixon", "min", "1", "time", "0",
            ])
            .stdin(Stdio::inherit())
            .status()?;
        if !configured.success() {
            return Err(io::Error::other("unable to configure raw terminal input"));
        }
        Ok(Self { settings })
    }
}

#[cfg(unix)]
impl Drop for RawTerminal {
    fn drop(&mut self) {
        let _ = Command::new("stty")
            .arg(&self.settings)
            .stdin(Stdio::inherit())
            .status();
        let mut stdout = io::stdout();
        let _ = stdout.write_all(b"\x1b[?25h\x1b[?1049l");
        let _ = stdout.flush();
    }
}

#[cfg(unix)]
fn terminal_size() -> (u16, u16) {
    let output = Command::new("stty").arg("size").output();
    if let Ok(output) = output {
        let values = String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .filter_map(|value| value.parse::<u16>().ok())
            .collect::<Vec<_>>();
        if values.len() >= 2 {
            return (values[1], values[0]);
        }
    }
    let width = env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(100);
    let height = env::var("LINES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(32);
    (width, height)
}

#[cfg(not(unix))]
fn terminal_size() -> (u16, u16) {
    let width = env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(100);
    let height = env::var("LINES")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(32);
    (width, height)
}

#[cfg(unix)]
fn read_key(input: &mut impl Read) -> io::Result<Key> {
    let mut first = [0u8; 1];
    input.read_exact(&mut first)?;
    match first[0] {
        0x03 => Ok(Key::Ctrl('c')),
        0x0c => Ok(Key::Ctrl('l')),
        0x09 => Ok(Key::Tab),
        0x7f | 0x08 => Ok(Key::Backspace),
        b'\r' | b'\n' => Ok(Key::Enter),
        0x1b => read_escape(input),
        value if value.is_ascii_control() => Ok(Key::Ctrl(value as char)),
        value if value < 0x80 => Ok(Key::Character(value as char)),
        value => read_utf8(input, value),
    }
}

#[cfg(unix)]
fn read_utf8(input: &mut impl Read, first: u8) -> io::Result<Key> {
    let width = match first {
        0xc2..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf4 => 4,
        _ => return Ok(Key::Escape),
    };
    let mut bytes = vec![first; width];
    input.read_exact(&mut bytes[1..])?;
    Ok(std::str::from_utf8(&bytes)
        .ok()
        .and_then(|value| value.chars().next())
        .map(Key::Character)
        .unwrap_or(Key::Escape))
}

#[cfg(unix)]
fn read_escape(input: &mut impl Read) -> io::Result<Key> {
    let mut second = [0u8; 1];
    input.read_exact(&mut second)?;
    if second[0] != b'[' {
        return Ok(Key::Escape);
    }
    let mut sequence = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        input.read_exact(&mut byte)?;
        sequence.push(byte[0]);
        if byte[0].is_ascii_alphabetic() || byte[0] == b'~' {
            break;
        }
    }
    let value = String::from_utf8_lossy(&sequence);
    Ok(match value.as_ref() {
        "A" => Key::Up,
        "B" => Key::Down,
        "5~" => Key::PageUp,
        "6~" => Key::PageDown,
        "Z" => Key::BackTab,
        "13;2u" | "1;2u" | "13;2~" => Key::ShiftEnter,
        _ => Key::Escape,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn decodes_utf8_input_as_one_character() {
        let mut input = Cursor::new("é".as_bytes());
        assert_eq!(read_key(&mut input).expect("read key"), Key::Character('é'));
    }

    #[test]
    fn maps_shift_enter_and_navigation_sequences() {
        let mut input = Cursor::new(b"\x1b[13;2u\x1b[5~\x1b[Z");
        assert_eq!(read_key(&mut input).expect("shift enter"), Key::ShiftEnter);
        assert_eq!(read_key(&mut input).expect("page up"), Key::PageUp);
        assert_eq!(read_key(&mut input).expect("back tab"), Key::BackTab);
    }

    #[test]
    fn encodes_and_decodes_multiline_bridge_values() {
        let value = "line one\nline two · ✓";
        let frame = format!("DELTA\t{}", hex_encode(value.as_bytes()));
        assert_eq!(
            parse_bridge_frame(&frame),
            Some(BridgeMessage::Event(ShellEvent::AssistantDelta(
                value.to_string()
            )))
        );
    }

    #[test]
    fn parses_context_and_plan_bridge_frames() {
        let frame = format!(
            "PLAN\t{}\t{}",
            hex_encode(b"conversation.respond"),
            hex_encode("inspect\u{1f}respond".as_bytes())
        );
        assert_eq!(
            parse_bridge_frame(&frame),
            Some(BridgeMessage::Event(ShellEvent::Plan {
                title: "conversation.respond".to_string(),
                steps: vec!["inspect".to_string(), "respond".to_string()],
            }))
        );
    }
}
