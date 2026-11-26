// The coordinator's project home: its real conversation in the centre,
// shared project records in Highlights, and quiet helper detail on Activity.
use crate::a11y::A11yRole as _;
use crate::app::Threadbear;
use crate::coordinators::Tab;
use crate::projects::project_icon;
use crate::spinner::Spinner;
use crate::style::{self, px, size};
use gpui_kit::base::TestSupportExt as _;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::{
    h_flex, v_flex, ActiveTheme as _, Disableable as _, Sizable as _, WindowExt as _,
};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use threadbear_core::coordinators::{Coordinator, State};
use threadbear_core::projects::{Project, TextField};

impl Threadbear {
    pub(crate) fn render_coordinator_home(
        &mut self,
        project: &Project,
        coordinator: &Coordinator,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.selected.as_deref() != Some(coordinator.thread_id.as_str()) || self.pane.is_none() {
            self.open(coordinator.thread_id.clone(), window, cx);
            self.projects.open = Some(project.id.clone());
        }
        let working = coordinator.working();
        let status = if coordinator.state == State::Paused {
            "Coordinator paused".to_owned()
        } else if working == 0 {
            "Coordinator on".to_owned()
        } else {
            format!(
                "Coordinator on · {working} helper{} working",
                if working == 1 { "" } else { "s" }
            )
        };
        let busy = self
            .coordinators
            .busy
            .contains(&format!("pause:{}", project.id));
        let pause = coordinator.clone();
        let header = h_flex()
            .w_full()
            .gap(px(13.))
            .items_center()
            .px(px(28.))
            .py(px(22.))
            .child(project_icon(Some(project), &project.title, 40., cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(5.))
                    .child(
                        div()
                            .text_size(px(24.))
                            .font_weight(FontWeight::BOLD)
                            .child(project.title.clone()),
                    )
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(style::secondary_text(cx))
                            .child(status),
                    ),
            )
            .child(control(
                "coordinator-pause",
                if coordinator.state == State::Paused {
                    "Resume"
                } else {
                    "Pause"
                },
                "Pause or resume the coordinator and its helpers",
                busy,
                cx,
                cx.listener(move |this, _: &ClickEvent, _, cx| this.pause_coordinator(&pause, cx)),
            ));
        let tabs = self.coordinator_tabs(coordinator, cx);
        let body = match self.coordinators.tab {
            Tab::Conversation => self.pane.as_ref().map_or_else(
                || {
                    div()
                        .p(px(30.))
                        .child("Loading the coordinator…")
                        .into_any_element()
                },
                |pane| div().size_full().child(pane.clone()).into_any_element(),
            ),
            Tab::Activity => self.render_coordinator_activity(coordinator, cx),
            Tab::Todos => self.render_coordinator_todos(coordinator, cx),
            Tab::Threads => {
                let threads = threadbear_core::projects::threads_in(
                    &project.id,
                    self.threads.values().map(|t| &**t),
                )
                .into_iter()
                .filter(|t| t.id != coordinator.thread_id)
                .cloned()
                .collect::<Vec<_>>();
                let list = self.render_threads_section(project, &threads, cx);
                div()
                    .id("coordinator-project-threads")
                    .size_full()
                    .overflow_y_scroll()
                    .p(px(28.))
                    .child(list)
                    .into_any_element()
            }
        };
        v_flex()
            .size_full()
            .child(header)
            .child(tabs)
            .child(div().flex_1().min_h_0().child(body))
            .into_any_element()
    }

    fn coordinator_tabs(&self, coordinator: &Coordinator, cx: &mut Context<Self>) -> AnyElement {
        let mut tabs = h_flex()
            .w_full()
            .px(px(28.))
            .gap(px(23.))
            .border_b_1()
            .border_color(cx.theme().border);
        for tab in Tab::ALL {
            let active = self.coordinators.tab == tab;
            let ink = if active {
                cx.theme().foreground
            } else {
                style::secondary_text(cx)
            };
            let mut label = h_flex().gap(px(6.)).child(tab.title());
            if tab == Tab::Conversation {
                let count = self
                    .threads
                    .get(&coordinator.thread_id)
                    .and_then(|t| t.asks.as_ref())
                    .map_or(0, Vec::len);
                if count > 0 {
                    label = label.child(
                        div()
                            .text_size(px(11.))
                            .text_color(style::link_text(cx))
                            .child(count.to_string()),
                    );
                }
            }
            tabs = tabs.child(
                crate::highlights::tipped(
                    div()
                        .id(SharedString::from(format!(
                            "coordinator-tab-{}",
                            tab.title()
                        )))
                        .role(Role::Tab)
                        .cursor_pointer()
                        .pb(px(13.))
                        .text_size(px(14.))
                        .text_color(ink)
                        .when(active, |s| s.border_b_2().border_color(style::accent(cx))),
                    format!("Show the project's {}", tab.title().to_lowercase()),
                )
                .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                    this.coordinators.tab = tab;
                    this.close_subagent(cx);
                    cx.notify();
                }))
                .child(label),
            );
        }
        tabs.into_any_element()
    }

    pub(crate) fn render_add_coordinator(
        &mut self,
        project: &Project,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        if !self.coordinators_on() || project.archived {
            return None;
        }
        let id = project.id.clone();
        Some(control(
            "project-add-coordinator",
            "Add a coordinator",
            "Add a coordinator that keeps this project's notes and work current",
            false,
            cx,
            cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.show_coordinator_setup(&id, window, cx)
            }),
        ))
    }

    pub(crate) fn show_coordinator_setup(
        &mut self,
        project: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.coordinators.setup.is_some() {
            return;
        }
        if self.coordinators.saved_picks.is_none() {
            self.coordinators.saved_picks = Some(self.new_thread.picks.clone());
        }
        self.choose_new_thread_runner(None, true, cx);
        let composer = self.ensure_new_composer(window, cx);
        let app = cx.entity();
        let project_id = project.to_owned();
        let start_key = format!("start:{project_id}");
        self.coordinators.setup_id = self.coordinators.setup_id.wrapping_add(1);
        let setup_id = self.coordinators.setup_id;
        self.coordinators.setup_close_dialog = false;
        self.coordinators.setup_error = None;
        self.coordinators.setup = Some(project_id.clone());
        let view = cx.new(|cx| CoordinatorSetupSheet {
            id: setup_id,
            app: app.downgrade(),
            composer,
            project: project_id,
            closing: false,
            _changes: cx.observe(&app, |_, _, cx| cx.notify()),
        });
        let app_for_busy = app.downgrade();
        let app_for_close = app.downgrade();
        cx.notify();
        window.open_dialog(cx, move |dialog, _, cx| {
            let busy = app_for_busy
                .upgrade()
                .is_some_and(|a| a.read(cx).coordinators.busy.contains(&start_key));
            let close_app = app_for_close.clone();
            dialog
                .w(px(460.))
                .centered()
                .entrance(gpui_kit::component::dialog::DialogEntrance::FadeSlide)
                .p(px(22.))
                .bg(cx.theme().popover)
                .rounded(px(14.))
                .close_button(false)
                .overlay_closable(!busy)
                .keyboard(!busy)
                .child(view.clone())
                .on_close(move |_, _, cx| {
                    if let Some(app) = close_app.upgrade() {
                        app.update(cx, |this, cx| {
                            this.close_coordinator_setup(Some(setup_id), cx)
                        });
                    }
                })
        });
        crate::web_panels::keyboard_to_app(window);
    }

    pub(crate) fn render_coordinator_document(
        &mut self,
        project: &Project,
        coordinator: &Coordinator,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut document = v_flex()
            .w_full()
            .gap(px(25.))
            .px(px(25.))
            .pt(px(26.))
            .pb(px(30.))
            .child(
                div()
                    .text_size(px(22.))
                    .font_weight(FontWeight::BOLD)
                    .child(project.title.clone()),
            )
            .child(self.render_text_section(project, TextField::Goals, window, cx))
            .child(self.render_text_section(project, TextField::State, window, cx));
        let work = coordinator
            .tasks
            .iter()
            .filter(|t| !t.finished())
            .take(3)
            .collect::<Vec<_>>();
        if !work.is_empty() {
            let mut tasks = v_flex().w_full().gap(px(12.)).child(heading("Work", cx));
            for task in work {
                tasks = tasks.child(
                    v_flex()
                        .gap(px(3.))
                        .child(
                            div()
                                .text_size(px(11.))
                                .text_color(style::secondary_text(cx))
                                .child(task.status_label()),
                        )
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(19.))
                                .child(task.title.clone()),
                        ),
                );
            }
            document = document.child(tasks);
        }
        let asks = self
            .threads
            .get(&coordinator.thread_id)
            .and_then(|t| t.asks.clone())
            .unwrap_or_default();
        if !asks.is_empty() {
            let mut questions = v_flex()
                .w_full()
                .gap(px(10.))
                .child(heading("Needs you", cx));
            for (index, ask) in asks.into_iter().enumerate() {
                questions = questions.child(
                    crate::highlights::tipped(
                        div()
                            .id(SharedString::from(format!("coordinator-question-{index}")))
                            .role(Role::Button)
                            .cursor_pointer()
                            .text_size(px(13.))
                            .line_height(px(20.))
                            .text_color(style::link_text(cx)),
                        "Show this question on the coordinator's card",
                    )
                    .on_click(cx.listener(|this, _: &ClickEvent, window, cx| {
                        this.coordinators.tab = Tab::Conversation;
                        if let Some(pane) = this.pane.clone() {
                            pane.update(cx, |p, cx| p.focus_composer(window, cx));
                        }
                        cx.notify();
                    }))
                    .child(ask.action),
                );
            }
            document = document.child(questions);
        }
        document = document.child(self.render_text_section(project, TextField::Notes, window, cx));
        if !project.links.is_empty() {
            let text = project
                .links
                .iter()
                .map(|l| format!("[{}]({})", l.title, l.url))
                .collect::<Vec<_>>()
                .join(" · ");
            document = document.child(v_flex().gap(px(12.)).child(heading("Links", cx)).child(
                crate::open_gate::reading_markdown_view(
                    SharedString::from(format!("coordinator-links-{}", project.id)),
                    text,
                    crate::open_gate::Origin::ThisMac,
                    project.folders.first().map_or("", String::as_str),
                ),
            ));
        }
        div()
            .id("coordinator-living-document")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.coordinators.document_scroll)
            .child(document)
            .into_any_element()
    }

    fn render_coordinator_todos(
        &mut self,
        coordinator: &Coordinator,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let mut list = v_flex()
            .w_full()
            .gap(px(18.))
            .p(px(28.))
            .child(heading("To-dos", cx));
        for task in &coordinator.tasks {
            list = list.child(
                v_flex()
                    .w_full()
                    .gap(px(7.))
                    .pb(px(17.))
                    .border_b_1()
                    .border_color(cx.theme().border)
                    .child(
                        div()
                            .text_size(px(12.))
                            .text_color(style::secondary_text(cx))
                            .child(task.status_label()),
                    )
                    .child(div().text_size(px(14.)).child(task.title.clone()))
                    .child(
                        div()
                            .text_size(px(12.))
                            .line_height(px(18.))
                            .text_color(style::secondary_text(cx))
                            .child(task.done_when.clone()),
                    ),
            );
        }
        let id = coordinator.project_id.clone();
        let busy = self.coordinators.busy.contains(&format!("task:{id}"));
        list = list.child(control(
            "coordinator-add-task",
            "Add a to-do",
            "Add work and what finished looks like",
            busy,
            cx,
            cx.listener(move |this, _: &ClickEvent, window, cx| {
                this.add_coordinator_task(&id, window, cx)
            }),
        ));
        div()
            .id("coordinator-todos")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.coordinators.work_scroll)
            .child(list)
            .into_any_element()
    }

    fn render_coordinator_activity(
        &mut self,
        coordinator: &Coordinator,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some(sub) = self.subagent_pane.clone() {
            return v_flex()
                .size_full()
                .child(self.render_subagent_header(cx))
                .child(div().flex_1().min_h_0().child(sub))
                .into_any_element();
        }
        let mut list = v_flex()
            .w_full()
            .gap(px(22.))
            .p(px(28.))
            .child(heading("Activity", cx));
        let helpers = self
            .threads
            .get(&coordinator.thread_id)
            .and_then(|t| t.subagents.clone())
            .unwrap_or_default();
        if helpers.is_empty() {
            list = list.child(
                div()
                    .text_size(px(13.))
                    .text_color(style::secondary_text(cx))
                    .child("Helper results appear here as the coordinator works."),
            );
        }
        for helper in helpers.iter().rev() {
            let Some(id) = helper["id"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let thread = coordinator.thread_id.clone();
            let id = id.to_owned();
            let title = helper["description"].as_str().unwrap_or("Helper");
            let state = helper["status"].as_str().unwrap_or("");
            let mut row = v_flex()
                .w_full()
                .gap(px(7.))
                .pb(px(18.))
                .border_b_1()
                .border_color(cx.theme().border)
                .child(div().text_size(px(14.)).child(title.to_owned()))
                .child(
                    div()
                        .text_size(px(12.))
                        .text_color(style::secondary_text(cx))
                        .child(state.to_owned()),
                );
            if let Some(summary) = helper["summary"].as_str() {
                row = row.child(
                    div()
                        .text_size(px(13.))
                        .line_height(px(20.))
                        .child(summary.to_owned()),
                );
            }
            row = row.child(control(
                SharedString::from(format!("coordinator-helper-{id}")),
                "Read helper messages",
                "Inspect this helper's conversation",
                false,
                cx,
                cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.open_subagent(thread.clone(), id.clone(), window, cx)
                }),
            ));
            list = list.child(row);
        }
        div()
            .id("coordinator-activity")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.coordinators.work_scroll)
            .child(list)
            .into_any_element()
    }

    pub(crate) fn coordinator_dump(&self, cx: &App) -> Value {
        let project = self.open_project();
        let current = project.and_then(|p| self.coordinator_for_project(&p.id));
        let highlights = crate::shell::HIGHLIGHTS;
        let document_shown = current.is_some()
            && self.panel_available(highlights, cx)
            && self.dock.read(cx).is_showing(highlights)
            && self
                .side
                .read(cx)
                .drawn
                .get(highlights)
                .is_some_and(|kind| kind == "project");
        let editing = self.projects.editing.as_ref().map(|e| {
            let current = self.project(&e.project).map(|p| e.field.text(p).to_owned());
            json!({"field":e.field.title(),"draft":e.input.read(cx).value().to_string(),"reviewCurrent":current.filter(|text| !e.saving && *text != e.baseline)})
        });
        json!({"on":self.coordinators_on(),"count":self.coordinators.list.len(),"tab":self.coordinators.tab.title(),"setup":self.coordinators.setup.clone(),"project":current.map(|c|c.project_id.clone()),"thread":current.map(|c|c.thread_id.clone()),"state":current.map(|c|if c.state==State::Paused{"paused"}else{"active"}),"tasks":current.map(|c|c.tasks.iter().map(|t|json!({"title":t.title,"state":t.status_label()})).collect::<Vec<_>>()),"documentShown":document_shown,"editing":editing,"document":project.map(|p|json!({"goals":p.goals,"state":p.state,"notes":p.notes}))})
    }
}

/// Centered dialog sheet for adding a coordinator to a project. Renders as a
/// child view so its composer can read the app cleanly outside the app render.
struct CoordinatorSetupSheet {
    id: u64,
    app: WeakEntity<Threadbear>,
    composer: Entity<crate::composer::Composer>,
    project: String,
    closing: bool,
    _changes: Subscription,
}

impl Render for CoordinatorSetupSheet {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(app_entity) = self.app.upgrade() else {
            return div().into_any_element();
        };
        let (active, close_now, project, busy, error) = {
            let app = app_entity.read(cx);
            let same = app.coordinators.setup_id == self.id;
            let active = same
                && app.coordinators_on()
                && app.coordinators.setup.as_deref() == Some(self.project.as_str());
            let close_now = same && app.coordinators.setup_close_dialog;
            let project = app.project(&self.project).cloned();
            let busy = app
                .coordinators
                .busy
                .contains(&format!("start:{}", self.project));
            let error = app.coordinators.setup_error.clone();
            (active, close_now, project, busy, error)
        };
        if !active {
            if close_now && !self.closing {
                self.closing = true;
                let id = self.id;
                let app = self.app.clone();
                window.defer(cx, move |window, cx| {
                    let should_close = app.upgrade().is_some_and(|a| {
                        a.update(cx, |this, _| {
                            if this.coordinators.setup_id == id
                                && this.coordinators.setup_close_dialog
                            {
                                this.coordinators.setup_close_dialog = false;
                                true
                            } else {
                                false
                            }
                        })
                    });
                    if should_close {
                        window.close_dialog(cx);
                    }
                });
            }
            return div().into_any_element();
        }
        let title = project
            .as_ref()
            .map_or_else(|| "project".to_owned(), |p| p.title.clone());
        let icon = project_icon(project.as_ref(), &title, 36., cx);
        let picker = self.composer.update(cx, |composer, cx| {
            composer.render_coordinator_picker(busy, window, cx)
        });
        let cancel_tip = "Keep the project as it is";
        let add_tip = "Start this project's coordinator using the chosen pool and model";
        v_flex()
            .id("coordinator-setup-sheet")
            .w_full()
            .gap(px(18.))
            .child(
                h_flex()
                    .w_full()
                    .items_start()
                    .gap(px(12.))
                    .child(icon)
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(4.))
                            .child(
                                div()
                                    .text_size(px(15.))
                                    .line_height(px(20.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(cx.theme().foreground)
                                    .child(format!("Add a {title} coordinator")),
                            )
                            .child(
                                div()
                                    .text_size(px(size::LABEL))
                                    .line_height(px(18.))
                                    .text_color(style::secondary_text(cx))
                                    .child("Starts from this project's goals, state and notes. Helpers report here, and it brings you decisions that need you."),
                            ),
                    ),
            )
            .child(picker)
            .when_some(error, |s, message| {
                s.child(
                    div()
                        .pl(px(60.))
                        .text_size(px(size::DETAIL))
                        .line_height(px(17.))
                        .text_color(style::failed(cx))
                        .child(message),
                )
            })
            .child(
                h_flex()
                    .w_full()
                    .justify_end()
                    .items_center()
                    .gap(px(8.))
                    .pt(px(2.))
                    .child(
                        div()
                            .id("coordinator-cancel-add")
                            .test_support()
                            .a11y_role(Role::GenericContainer)
                            .aria_label(cancel_tip.to_owned())
                            .child(
                                Button::new("coordinator-cancel-add-button")
                                    .label("Cancel")
                                    .outline()
                                    .disabled(busy)
                                    .tooltip(cancel_tip)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.closing = true;
                                        window.close_dialog(cx);
                                        if let Some(app) = this.app.upgrade() {
                                            let id = this.id;
                                            app.update(cx, |app, cx| {
                                                app.close_coordinator_setup(Some(id), cx)
                                            });
                                        }
                                    })),
                            ),
                    )
                    .child(
                        div()
                            .id("coordinator-confirm-add")
                            .test_support()
                            .a11y_role(Role::GenericContainer)
                            .aria_label(add_tip.to_owned())
                            .child(
                                Button::new("coordinator-confirm-add-button")
                                    .label("Add coordinator")
                                    .primary()
                                    .loading(busy)
                                    .disabled(busy)
                                    .tooltip(add_tip)
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        if let Some(app) = this.app.upgrade() {
                                            let project_id = this.project.clone();
                                            let id = this.id;
                                            app.update(cx, |app, cx| {
                                                app.start_coordinator(&project_id, id, window, cx)
                                            });
                                        }
                                    })),
                            ),
                    ),
            )
            .into_any_element()
    }
}

fn heading(text: &str, cx: &App) -> AnyElement {
    div()
        .text_size(px(14.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(cx.theme().foreground)
        .child(text.to_owned())
        .into_any_element()
}

fn control(
    id: impl Into<ElementId>,
    label: &str,
    tip: &str,
    busy: bool,
    cx: &App,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    crate::highlights::tipped(
        h_flex()
            .id(id)
            .role(Role::Button)
            .flex_none()
            .self_start()
            .gap(px(7.))
            .items_center()
            .px(px(11.))
            .py(px(6.))
            .rounded(px(6.))
            .bg(style::primary_opacity(cx, 0.08))
            .text_size(px(12.))
            .text_color(cx.theme().foreground)
            .when(!busy, |s| s.cursor_pointer().on_click(on_click))
            .when(busy, |s| {
                s.child(
                    Spinner::new()
                        .with_size(px(12.))
                        .color(style::secondary_text(cx)),
                )
            }),
        tip.to_owned(),
    )
    .child(label.to_owned())
    .into_any_element()
}
