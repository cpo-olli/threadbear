// The project's coordinator uses an ordinary thread and its existing
// composer. Only its project link and helper-owned work live here.
use crate::app::Threadbear;
use crate::call;
use crate::style::px;
use gpui_kit::component::dialog::DialogButtonProps;
use gpui_kit::component::input::{Input, InputState};
use gpui_kit::component::{v_flex, WindowExt as _};
use gpui_kit::prelude::*;
use gpui_kit::*;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;
use threadbear_core::coordinators::{Coordinator, State};
use threadbear_core::inbox::ThreadSummary;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Tab {
    #[default]
    Conversation,
    Activity,
    Todos,
    Threads,
}

impl Tab {
    pub(crate) const ALL: [Self; 4] = [
        Self::Conversation,
        Self::Activity,
        Self::Todos,
        Self::Threads,
    ];

    pub(crate) fn title(self) -> &'static str {
        match self {
            Self::Conversation => "Conversation",
            Self::Activity => "Activity",
            Self::Todos => "To-dos",
            Self::Threads => "Threads",
        }
    }
}

#[derive(Default)]
pub(crate) struct CoordinatorsState {
    pub(crate) list: Vec<Coordinator>,
    pub(crate) tab: Tab,
    pub(crate) setup: Option<String>,
    pub(crate) setup_controls: Option<Entity<CoordinatorControls>>,
    pub(crate) saved_picks: Option<threadbear_core::new_thread::NewThreadPicks>,
    pub(crate) busy: HashSet<String>,
    pub(crate) document_scroll: ScrollHandle,
    pub(crate) work_scroll: ScrollHandle,
}

impl Threadbear {
    pub(crate) fn coordinators_on(&self) -> bool {
        self.remote.experiments.iter().any(|e| e == "coordinators")
    }

    pub(crate) fn coordinator_for_project(&self, id: &str) -> Option<&Coordinator> {
        self.coordinators_on()
            .then(|| self.coordinators.list.iter().find(|c| c.project_id == id))
            .flatten()
    }

    pub(crate) fn coordinator_project_for_thread(&self, id: &str) -> Option<String> {
        self.coordinators_on()
            .then(|| self.coordinators.list.iter().find(|c| c.thread_id == id))
            .flatten()
            .map(|c| c.project_id.clone())
    }

    pub(crate) fn load_coordinators(&mut self, cx: &mut Context<Self>) {
        if !self.coordinators_on() {
            self.receive_coordinators(&json!([]));
            return;
        }
        let client = self.client.clone();
        cx.spawn(async move |this, cx| {
            let result = call(client, "coordinators.list", json!({})).await;
            this.update(cx, |this, cx| {
                if !this.coordinators_on() {
                    return;
                }
                match result {
                    Ok(value) => this.receive_coordinators(&value["coordinators"]),
                    Err(error) => this.show_error(error.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn receive_coordinators(&mut self, value: &Value) {
        if !value.is_array() {
            return;
        }
        self.coordinators.list = threadbear_core::coordinators::Coordinator::list(value);
        self.invalidate_coordinator_sections();
    }

    pub(crate) fn show_coordinator_setup(
        &mut self,
        project: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.coordinators.saved_picks.is_none() {
            self.coordinators.saved_picks = Some(self.new_thread.picks.clone());
        }
        self.choose_new_thread_runner(None, true, cx);
        let composer = self.ensure_new_composer(window, cx);
        let app = cx.entity();
        let project_id = project.to_owned();
        self.coordinators.setup_controls = Some(cx.new(|cx| CoordinatorControls {
            app: app.downgrade(),
            composer,
            project: project_id,
            _changes: cx.observe(&app, |_, _, cx| cx.notify()),
        }));
        self.coordinators.setup = Some(project.to_owned());
        cx.notify();
    }

    pub(crate) fn close_coordinator_setup(&mut self, cx: &mut Context<Self>) {
        self.coordinators.setup = None;
        self.coordinators.setup_controls = None;
        if let Some(picks) = self.coordinators.saved_picks.take() {
            self.new_thread.picks = picks;
        }
        cx.notify();
    }

    pub(crate) fn start_coordinator(
        &mut self,
        project: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let key = format!("start:{project}");
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        let logins = self.draft_logins();
        let selection = self.with_draft(&logins, |d| d.create_params("", Vec::new(), false));
        let mut params = json!({"projectId":project});
        for name in ["accountId", "poolId", "model", "effort"] {
            if let Some(value) = selection.get(name) {
                params[name] = value.clone();
            }
        }
        let client = self.client.clone();
        let project = project.to_owned();
        cx.notify();
        cx.spawn_in(window, async move |this, cx| {
            let result = call(client, "coordinators.start", params).await;
            this.update_in(cx, |this, window, cx| {
                this.coordinators.busy.remove(&key);
                match result {
                    Ok(value) => {
                        if let Some(coordinator) = Coordinator::decode(&value["coordinator"]) {
                            this.coordinators.list.retain(|c| c.project_id != project);
                            this.coordinators.list.push(coordinator.clone());
                            this.invalidate_coordinator_sections();
                            if let Ok(thread) =
                                serde_json::from_value::<ThreadSummary>(value["thread"].clone())
                            {
                                this.threads.insert(thread.id.clone(), Arc::new(thread));
                            }
                            this.close_coordinator_setup(cx);
                            this.coordinators.tab = Tab::Conversation;
                            this.open(coordinator.thread_id, window, cx);
                            this.projects.open = Some(project);
                            this.show_pane(crate::shell::HIGHLIGHTS, cx);
                            this.load_list(cx);
                        } else {
                            this.show_error(
                                "The runner did not return the coordinator it made.".to_owned(),
                                cx,
                            );
                            this.load_coordinators(cx);
                        }
                    }
                    Err(error) => this.show_error(error.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    pub(crate) fn pause_coordinator(&mut self, coordinator: &Coordinator, cx: &mut Context<Self>) {
        let key = format!("pause:{}", coordinator.project_id);
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        let client = self.client.clone();
        let params =
            json!({"projectId":coordinator.project_id,"paused":coordinator.state != State::Paused});
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(client, "coordinators.pause", params).await;
            this.update(cx, |this, cx| {
                this.coordinators.busy.remove(&key);
                match result {
                    Ok(value) => this.replace_coordinator(&value["coordinator"]),
                    Err(error) => {
                        this.show_error(error.message, cx);
                        this.load_coordinators(cx);
                    }
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn replace_coordinator(&mut self, value: &Value) {
        if let Some(coordinator) = Coordinator::decode(value) {
            if let Some(existing) = self
                .coordinators
                .list
                .iter_mut()
                .find(|c| c.project_id == coordinator.project_id)
            {
                *existing = coordinator;
            } else {
                self.coordinators.list.push(coordinator);
            }
            self.invalidate_coordinator_sections();
        }
    }

    pub(crate) fn add_coordinator_task(
        &mut self,
        project: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let title = cx.new(|cx| InputState::new(window, cx).placeholder("What needs doing?"));
        let done =
            cx.new(|cx| InputState::new(window, cx).placeholder("What does finished look like?"));
        let app = cx.weak_entity();
        let (project, typed, outcome) = (project.to_owned(), title.clone(), done);
        window.open_alert_dialog(cx, move |dialog, _, _| {
            let (app, project, title, done) =
                (app.clone(), project.clone(), typed.clone(), outcome.clone());
            dialog
                .title("Add a to-do")
                .width(px(430.))
                .child(
                    v_flex()
                        .gap(px(12.))
                        .child(Input::new(&typed))
                        .child(Input::new(&outcome)),
                )
                .button_props(
                    DialogButtonProps::default()
                        .ok_text("Add")
                        .show_cancel(true),
                )
                .on_ok(move |_, _, cx| {
                    let title = title.read(cx).value().trim().to_owned();
                    let done = done.read(cx).value().trim().to_owned();
                    if title.is_empty() || done.is_empty() {
                        return false;
                    }
                    app.update(cx, |this, cx| {
                        this.send_coordinator_task(&project, title, done, cx)
                    })
                    .ok();
                    true
                })
        });
        window.focus(&title.read(cx).focus_handle(cx), cx);
    }

    fn send_coordinator_task(
        &mut self,
        project: &str,
        title: String,
        done: String,
        cx: &mut Context<Self>,
    ) {
        let key = format!("task:{project}");
        if !self.coordinators.busy.insert(key.clone()) {
            return;
        }
        let client = self.client.clone();
        let params = json!({"projectId":project,"title":title,"doneWhen":done});
        cx.notify();
        cx.spawn(async move |this, cx| {
            let result = call(client, "coordinators.addTask", params).await;
            this.update(cx, |this, cx| {
                this.coordinators.busy.remove(&key);
                match result {
                    Ok(value) => this.replace_coordinator(&value["coordinator"]),
                    Err(error) => this.show_error(error.message, cx),
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }
}

/// The standard picker row renders as a child view: its composer reads the
/// app, so it must run after the project's own render has released it.
pub(crate) struct CoordinatorControls {
    app: WeakEntity<Threadbear>,
    composer: Entity<crate::composer::Composer>,
    project: String,
    _changes: Subscription,
}

impl Render for CoordinatorControls {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = self.app.upgrade().is_some_and(|app| {
            app.read(cx)
                .coordinators
                .busy
                .contains(&format!("start:{}", self.project))
        });
        let (app, project) = (self.app.clone(), self.project.clone());
        let add = crate::coordinator_home::control(
            "coordinator-confirm-add",
            "Add coordinator",
            "Start this project's coordinator using the chosen pool and model",
            busy,
            cx,
            move |_, window, cx| {
                app.update(cx, |this, cx| this.start_coordinator(&project, window, cx))
                    .ok();
            },
        );
        self.composer.update(cx, |composer, cx| {
            composer.render_coordinator_picker(add, window, cx)
        })
    }
}
