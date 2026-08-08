#![forbid(unsafe_code)]

pub mod terminal;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Pane {
    Command,
    Inspector,
    Logs,
}

impl Pane {
    pub const fn next(self) -> Self {
        match self {
            Self::Command => Self::Inspector,
            Self::Inspector => Self::Logs,
            Self::Logs => Self::Command,
        }
    }

    pub const fn previous(self) -> Self {
        match self {
            Self::Command => Self::Logs,
            Self::Inspector => Self::Command,
            Self::Logs => Self::Inspector,
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Inspector => "inspector",
            Self::Logs => "logs",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LayoutMode {
    Auto,
    Wide,
    Narrow,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Key {
    Character(char),
    Backspace,
    Enter,
    ShiftEnter,
    Tab,
    BackTab,
    Up,
    Down,
    PageUp,
    PageDown,
    Escape,
    Ctrl(char),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Action {
    None,
    Redraw,
    Quit,
    Submit(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellEvent {
    AssistantDelta(String),
    AssistantMessage(String),
    Plan {
        title: String,
        steps: Vec<String>,
    },
    ApprovalRequired {
        title: String,
        summary: String,
    },
    RunStatus {
        state: String,
        detail: String,
    },
    Log {
        level: String,
        message: String,
    },
    Diff {
        path: String,
        removed: Vec<String>,
        added: Vec<String>,
    },
    Connection {
        state: String,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum TranscriptEntry {
    System(String),
    User(String),
    Assistant(String),
    Plan(String),
    Approval(String),
    Diff {
        path: String,
        removed: Vec<String>,
        added: Vec<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LogEntry {
    level: String,
    message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellState {
    workspace: String,
    project: String,
    model: String,
    transcript: Vec<TranscriptEntry>,
    logs: Vec<LogEntry>,
    inspector: Vec<String>,
    composer: String,
    cursor: usize,
    active_pane: Pane,
    layout: LayoutMode,
    connection: String,
    run_status: String,
    scroll: usize,
}

impl ShellState {
    pub fn new(
        workspace: impl Into<String>,
        project: impl Into<String>,
        model: impl Into<String>,
    ) -> Self {
        Self {
            workspace: workspace.into(),
            project: project.into(),
            model: model.into(),
            transcript: vec![TranscriptEntry::System(
                "Spyderbyte shell ready; backend events are rendered through the client boundary."
                    .to_string(),
            )],
            logs: vec![LogEntry {
                level: "info".to_string(),
                message: "terminal host initialized".to_string(),
            }],
            inspector: vec![
                "presentation-only shell".to_string(),
                "awaiting typed Spyderbyte events".to_string(),
            ],
            composer: String::new(),
            cursor: 0,
            active_pane: Pane::Command,
            layout: LayoutMode::Auto,
            connection: "local".to_string(),
            run_status: "idle".to_string(),
            scroll: 0,
        }
    }

    pub fn active_pane(&self) -> Pane {
        self.active_pane
    }

    pub fn layout(&self) -> LayoutMode {
        self.layout
    }

    pub fn draft(&self) -> &str {
        &self.composer
    }

    pub fn connection(&self) -> &str {
        &self.connection
    }

    pub fn set_layout(&mut self, layout: LayoutMode) {
        self.layout = layout;
    }

    pub fn set_context(
        &mut self,
        workspace: impl Into<String>,
        project: impl Into<String>,
        model: impl Into<String>,
    ) {
        self.workspace = workspace.into();
        self.project = project.into();
        self.model = model.into();
    }

    pub fn apply_event(&mut self, event: ShellEvent) {
        match event {
            ShellEvent::AssistantDelta(delta) => {
                if let Some(TranscriptEntry::Assistant(message)) = self.transcript.last_mut() {
                    message.push_str(&delta);
                } else {
                    self.transcript.push(TranscriptEntry::Assistant(delta));
                }
                self.run_status = "streaming".to_string();
            }
            ShellEvent::AssistantMessage(message) => {
                self.transcript.push(TranscriptEntry::Assistant(message));
                self.run_status = "succeeded".to_string();
            }
            ShellEvent::Plan { title, steps } => {
                self.transcript.push(TranscriptEntry::Plan(title.clone()));
                self.inspector = std::iter::once(format!("plan: {title}"))
                    .chain(steps.into_iter().map(|step| format!("• {step}")))
                    .collect();
            }
            ShellEvent::ApprovalRequired { title, summary } => {
                self.transcript
                    .push(TranscriptEntry::Approval(title.clone()));
                self.inspector = vec![
                    "approval required".to_string(),
                    title,
                    summary,
                    "use the backend client to decide".to_string(),
                ];
                self.run_status = "awaiting approval".to_string();
            }
            ShellEvent::RunStatus { state, detail } => {
                self.run_status = state.clone();
                self.logs.push(LogEntry {
                    level: "run".to_string(),
                    message: format!("{state}: {detail}"),
                });
            }
            ShellEvent::Log { level, message } => {
                self.logs.push(LogEntry { level, message });
            }
            ShellEvent::Diff {
                path,
                removed,
                added,
            } => {
                self.transcript.push(TranscriptEntry::Diff {
                    path,
                    removed,
                    added,
                });
            }
            ShellEvent::Connection { state } => {
                self.connection = state.clone();
                self.logs.push(LogEntry {
                    level: "connection".to_string(),
                    message: state,
                });
            }
        }
    }

    pub fn handle_key(&mut self, key: Key) -> Action {
        match key {
            Key::Ctrl('c') | Key::Ctrl('q') => Action::Quit,
            Key::Ctrl('l') => {
                self.transcript.clear();
                self.logs.push(LogEntry {
                    level: "info".to_string(),
                    message: "transcript cleared".to_string(),
                });
                Action::Redraw
            }
            Key::Character(character) => {
                self.composer.insert(self.cursor, character);
                self.cursor += character.len_utf8();
                Action::Redraw
            }
            Key::Backspace => {
                if self.cursor > 0 {
                    let previous = self.composer[..self.cursor]
                        .char_indices()
                        .last()
                        .map(|(index, _)| index)
                        .unwrap_or(0);
                    self.composer.drain(previous..self.cursor);
                    self.cursor = previous;
                }
                Action::Redraw
            }
            Key::ShiftEnter => {
                self.composer.insert(self.cursor, '\n');
                self.cursor += 1;
                Action::Redraw
            }
            Key::Enter => {
                if self.composer.trim().is_empty() {
                    return Action::Redraw;
                }
                let submitted = self.composer.clone();
                self.transcript
                    .push(TranscriptEntry::User(submitted.clone()));
                self.logs.push(LogEntry {
                    level: "draft".to_string(),
                    message: "submitted to the typed client boundary".to_string(),
                });
                self.composer.clear();
                self.cursor = 0;
                Action::Submit(submitted)
            }
            Key::Tab => {
                self.active_pane = self.active_pane.next();
                Action::Redraw
            }
            Key::BackTab => {
                self.active_pane = self.active_pane.previous();
                Action::Redraw
            }
            Key::Up => {
                self.scroll = self.scroll.saturating_add(1);
                Action::Redraw
            }
            Key::Down => {
                self.scroll = self.scroll.saturating_sub(1);
                Action::Redraw
            }
            Key::PageUp => {
                self.scroll = self.scroll.saturating_add(6);
                Action::Redraw
            }
            Key::PageDown => {
                self.scroll = self.scroll.saturating_sub(6);
                Action::Redraw
            }
            Key::Escape => {
                self.composer.clear();
                self.cursor = 0;
                Action::Redraw
            }
            Key::Ctrl(_) => Action::None,
        }
    }

    pub fn render(&self, width: u16, height: u16) -> String {
        let width = usize::from(width.max(40));
        let height = usize::from(height.max(12));
        let narrow = match self.layout {
            LayoutMode::Narrow => true,
            LayoutMode::Wide => false,
            LayoutMode::Auto => width < 100,
        };
        let mut lines = vec![
            format!(
                "SPYDERBYTE // terminal shell   workspace: {}   project: {}",
                self.workspace, self.project
            ),
            format!(
                "model: {}   connection: {}   run: {}   focus: {}",
                self.model,
                self.connection,
                self.run_status,
                self.active_pane.label()
            ),
        ];
        if narrow {
            lines.extend(panel("conversation", &self.conversation_lines(), width));
            lines.extend(panel("inspector", &self.inspector, width));
            lines.extend(panel("logs", &self.log_lines(), width));
        } else {
            let left_width = ((width.saturating_mul(2)) / 3).max(48);
            let right_width = width.saturating_sub(left_width).saturating_sub(1).max(24);
            let left = panel("conversation", &self.conversation_lines(), left_width);
            let right = panel("inspector", &self.inspector, right_width);
            let rows = left.len().max(right.len());
            lines.push(format!(
                "┌{}┬{}┐",
                "─".repeat(left_width - 2),
                "─".repeat(right_width - 2)
            ));
            for index in 0..rows {
                let left_row = fit(
                    left.get(index).map(String::as_str).unwrap_or(""),
                    left_width - 2,
                );
                let right_row = fit(
                    right.get(index).map(String::as_str).unwrap_or(""),
                    right_width - 2,
                );
                lines.push(format!(
                    "│ {left_row:<left_inner$}│ {right_row:<right_inner$}│",
                    left_inner = left_width - 2,
                    right_inner = right_width - 2
                ));
            }
            lines.push(format!(
                "└{}┴{}┘",
                "─".repeat(left_width - 2),
                "─".repeat(right_width - 2)
            ));
            lines.extend(panel("logs", &self.log_lines(), width));
        }
        let composer = if self.composer.is_empty() {
            "(type a request; Enter submits, Shift+Enter adds a line)".to_string()
        } else {
            self.composer.clone()
        };
        lines.extend(panel("command", &vec![composer], width));
        lines.push("keys: Tab focus  ↑/↓ scroll  PgUp/PgDn page  Ctrl+C quit".to_string());
        lines
            .into_iter()
            .take(height)
            .map(|line| fit(&line, width))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn conversation_lines(&self) -> Vec<String> {
        let mut lines = Vec::new();
        for entry in &self.transcript {
            match entry {
                TranscriptEntry::System(text) => lines.push(format!("• {text}")),
                TranscriptEntry::User(text) => lines.extend(markdown_lines("> ", text)),
                TranscriptEntry::Assistant(text) => {
                    lines.extend(markdown_lines("assistant: ", text))
                }
                TranscriptEntry::Plan(title) => lines.push(format!("plan: {title}")),
                TranscriptEntry::Approval(title) => {
                    lines.push(format!("⚠ approval required: {title}"))
                }
                TranscriptEntry::Diff {
                    path,
                    removed,
                    added,
                } => {
                    lines.push(format!("diff: {path}"));
                    lines.extend(removed.iter().map(|line| format!("- {line}")));
                    lines.extend(added.iter().map(|line| format!("+ {line}")));
                }
            }
        }
        if self.scroll > 0 && self.scroll < lines.len() {
            lines[..lines.len() - self.scroll].to_vec()
        } else {
            lines
        }
    }

    fn log_lines(&self) -> Vec<String> {
        self.logs
            .iter()
            .rev()
            .take(8)
            .rev()
            .map(|entry| format!("[{}] {}", entry.level, entry.message))
            .collect()
    }
}

fn markdown_lines(prefix: &str, text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut code = false;
    for line in text.lines() {
        if line.trim_start().starts_with("~~~") {
            code = !code;
            lines.push(if code {
                format!("{prefix}┌─ code")
            } else {
                format!("{prefix}└─ code")
            });
            continue;
        }
        if code {
            lines.push(format!("{prefix}│ {line}"));
        } else if let Some(heading) = line.strip_prefix("# ") {
            lines.push(format!("{prefix}{heading}"));
        } else {
            lines.push(format!("{prefix}{line}"));
        }
    }
    if lines.is_empty() {
        lines.push(prefix.to_string());
    }
    lines
}

fn panel(title: &str, content: &[String], width: usize) -> Vec<String> {
    let inner = width.saturating_sub(4).max(8);
    let title_width = title.len() + 3;
    let rule_width = inner.saturating_sub(title_width);
    let mut lines = vec![format!("┌─ {title} {}┐", "─".repeat(rule_width))];
    for line in content {
        for wrapped in wrap(line, inner) {
            lines.push(format!("│ {wrapped:<inner$} │", inner = inner));
        }
    }
    lines.push(format!("└{}┘", "─".repeat(width.saturating_sub(2))));
    lines
}

fn wrap(value: &str, width: usize) -> Vec<String> {
    let mut result = Vec::new();
    for source in value.lines() {
        if source.is_empty() {
            result.push(String::new());
            continue;
        }
        let mut current = String::new();
        for character in source.chars() {
            current.push(character);
            if current.chars().count() >= width {
                result.push(current);
                current = String::new();
            }
        }
        if !current.is_empty() {
            result.push(current);
        }
    }
    if result.is_empty() {
        result.push(String::new());
    }
    result
}

fn fit(value: &str, width: usize) -> String {
    let mut result = value.chars().take(width).collect::<String>();
    let length = result.chars().count();
    if length < width {
        result.push_str(&" ".repeat(width - length));
    }
    result
}

pub fn help_text() -> &'static str {
    "Spyderbyte terminal shell\n\nUsage: spyderbyte [--plain] [--workspace <path>] [--project <id>]\n\nThe shell is a presentation host. Provider, runtime, policy, approval, and Run decisions come from Spyderbyte services.\n\nKeys: Enter submit, Shift+Enter newline, Tab focus, PgUp/PgDn scroll, Ctrl+C quit."
}

pub fn demo_state() -> ShellState {
    let mut state = ShellState::new("current workspace", "project context", "backend selection");
    state.apply_event(ShellEvent::Plan {
        title: "Inspect the request and prepare a safe action".to_string(),
        steps: vec![
            "Inspect current project context".to_string(),
            "Present an execution plan".to_string(),
            "Wait for the authoritative decision".to_string(),
        ],
    });
    state.apply_event(ShellEvent::AssistantMessage(
        "# Ready\nThe shell renders typed events and leaves authority to Spyderbyte services.\n\n~~~text\noutput is presentation-only\n~~~"
            .to_string(),
    ));
    state.apply_event(ShellEvent::RunStatus {
        state: "idle".to_string(),
        detail: "no backend run submitted".to_string(),
    });
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_branded_and_does_not_inherit_account_or_cloud_copy() {
        let help = help_text().to_ascii_lowercase();
        assert!(help.contains("spyderbyte"));
        assert!(!help.contains("codex"));
        assert!(!help.contains("openai"));
        assert!(!help.contains("account"));
        assert!(!help.contains("cloud"));
        assert!(!help.contains("sign in"));
    }

    #[test]
    fn renders_typed_events_in_wide_and_narrow_layouts() {
        let mut state = ShellState::new("workspace", "project", "selected model");
        state.apply_event(ShellEvent::Plan {
            title: "Profile data".to_string(),
            steps: vec!["Inspect schema".to_string(), "Ask for approval".to_string()],
        });
        state.apply_event(ShellEvent::AssistantMessage(
            "# Result\n~~~python\nprint('ok')\n~~~".to_string(),
        ));
        state.apply_event(ShellEvent::Log {
            level: "info".to_string(),
            message: "stream connected".to_string(),
        });
        let wide = state.render(120, 40);
        assert!(wide.contains("SPYDERBYTE"));
        assert!(wide.contains("inspector"));
        assert!(wide.contains("Profile data"));
        assert!(wide.contains("print('ok')"));
        assert!(wide.contains("stream connected"));
        state.set_layout(LayoutMode::Narrow);
        let narrow = state.render(70, 40);
        assert!(narrow.contains("conversation"));
        assert!(narrow.contains("command"));
    }

    #[test]
    fn supports_multiline_composer_and_keyboard_focus() {
        let mut state = ShellState::new("workspace", "project", "model");
        assert_eq!(state.handle_key(Key::Character('a')), Action::Redraw);
        assert_eq!(state.handle_key(Key::ShiftEnter), Action::Redraw);
        assert_eq!(state.handle_key(Key::Character('b')), Action::Redraw);
        assert_eq!(state.draft(), "a\nb");
        assert_eq!(state.active_pane(), Pane::Command);
        assert_eq!(state.handle_key(Key::Tab), Action::Redraw);
        assert_eq!(state.active_pane(), Pane::Inspector);
        assert_eq!(
            state.handle_key(Key::Enter),
            Action::Submit("a\nb".to_string())
        );
        assert!(state.draft().is_empty());
    }

    #[test]
    fn provider_and_run_authority_are_not_shell_state() {
        let state = ShellState::new("workspace", "project", "backend selection");
        let debug = format!("{state:?}").to_ascii_lowercase();
        assert!(!debug.contains("credential"));
        assert!(!debug.contains("api_key"));
        assert!(!debug.contains("provider_id"));
    }

    #[test]
    fn diff_and_approval_events_are_rendered_without_deciding_them() {
        let mut state = ShellState::new("workspace", "project", "model");
        state.apply_event(ShellEvent::ApprovalRequired {
            title: "Run Python".to_string(),
            summary: "The service requests approval for a filesystem write.".to_string(),
        });
        state.apply_event(ShellEvent::Diff {
            path: "analysis.py".to_string(),
            removed: vec!["old()".to_string()],
            added: vec!["new()".to_string()],
        });
        let rendered = state.render(140, 40);
        assert!(rendered.contains("approval required"));
        assert!(rendered.contains("analysis.py"));
        assert!(rendered.contains("- old()"));
        assert!(rendered.contains("+ new()"));
        assert!(rendered.contains("use the backend client to decide"));
    }

    #[test]
    fn fit_and_wrap_keep_rendering_bounded() {
        let mut state = ShellState::new("workspace", "project", "model");
        state.apply_event(ShellEvent::AssistantMessage("x".repeat(500)));
        let rendered = state.render(48, 14);
        assert!(rendered.lines().count() <= 14);
        assert!(rendered.lines().all(|line| line.chars().count() <= 48));
    }

    #[test]
    fn format_helpers_are_used_without_external_terminal_authority() {
        let mut output = String::new();
        output.push_str(help_text());
        assert!(output.starts_with("Spyderbyte"));
    }
}
