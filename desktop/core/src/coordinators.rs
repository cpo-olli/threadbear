//! A project's coordinator and its work, read from `coordinators.*`.
//! Project prose stays in `projects`; these records only link its conversation
//! and the helper runs that own each task's state.
use crate::inbox::{Section, ThreadSummary};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Active,
    Paused,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub done_when: String,
    pub agent_id: Option<String>,
    pub status: String,
    pub summary: Option<String>,
}

impl Task {
    pub fn status_label(&self) -> &'static str {
        match self.status.as_str() {
            "running" => "Helper working",
            "completed" => "Done",
            "interrupted" => "Interrupted",
            "failed" => "Failed",
            "stopped" => "Stopped",
            _ => "To do",
        }
    }

    pub fn finished(&self) -> bool {
        self.status == "completed"
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coordinator {
    pub project_id: String,
    pub thread_id: String,
    pub state: State,
    pub charter: String,
    pub interests: Vec<String>,
    pub tasks: Vec<Task>,
    pub updated_at: String,
}

fn identity(v: &Value, field: &str) -> Option<String> {
    v[field]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
}

impl Coordinator {
    pub fn decode(v: &Value) -> Option<Self> {
        let state = match v["state"].as_str()? {
            "active" => State::Active,
            "paused" => State::Paused,
            _ => return None,
        };
        Some(Self {
            project_id: identity(v, "projectId")?,
            thread_id: identity(v, "threadId")?,
            state,
            charter: v["charter"].as_str().unwrap_or("").to_owned(),
            interests: v["interests"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            tasks: v["tasks"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    Some(Task {
                        id: identity(t, "id")?,
                        title: identity(t, "title")?,
                        done_when: t["doneWhen"].as_str().unwrap_or("").to_owned(),
                        agent_id: identity(&t["run"], "agentId"),
                        status: t["run"]["status"].as_str().unwrap_or("queued").to_owned(),
                        summary: t["run"]["summary"].as_str().map(str::to_owned),
                    })
                })
                .collect(),
            updated_at: v["updatedAt"].as_str().unwrap_or("").to_owned(),
        })
    }

    pub fn list(v: &Value) -> Vec<Self> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(Self::decode)
            .collect()
    }

    pub fn working(&self) -> usize {
        self.tasks.iter().filter(|t| t.status == "running").count()
    }
}

/// Coordinators keep their place above Starred. Their ordinary thread is
/// removed from every other section exactly once, except after archiving.
pub fn sections(
    mut sections: Vec<Section<Arc<ThreadSummary>>>,
    coordinators: &[Coordinator],
) -> Vec<Section<Arc<ThreadSummary>>> {
    let mut rows = Vec::new();
    for coordinator in coordinators {
        for section in &mut sections {
            if section.key == "archived" {
                continue;
            }
            if let Some(index) = section
                .rows
                .iter()
                .position(|t| t.id == coordinator.thread_id)
            {
                rows.push(section.rows.remove(index));
                break;
            }
        }
    }
    sections.retain(|s| !s.rows.is_empty() || s.key == "inbox");
    if !rows.is_empty() {
        sections.insert(
            0,
            Section {
                key: "coordinators",
                title: "Coordinators",
                rows,
            },
        );
    }
    sections
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unreadable_identity_or_lifecycle_never_hides_an_ordinary_thread() {
        for v in [
            json!({"projectId":"p", "threadId":"", "state":"active"}),
            json!({"projectId":3, "threadId":"t", "state":"active"}),
            json!({"projectId":"p", "threadId":"t", "state":"future-state"}),
        ] {
            assert!(Coordinator::decode(&v).is_none());
        }
    }

    #[test]
    fn helper_result_is_the_task_state() {
        let c = Coordinator::decode(&json!({
            "projectId":"p", "threadId":"t", "state":"active", "tasks":[
                {"id":"a", "title":"Fix a bug", "doneWhen":"Review passes", "run":{"status":"completed","agentId":"worker"}},
                {"id":"b", "title":"Next job"},
                {"id":null, "title":"Broken row"}
            ]
        })).unwrap();
        assert_eq!(c.tasks.len(), 2);
        assert!(c.tasks[0].finished());
        assert_eq!(c.tasks[1].status_label(), "To do");
    }

    #[test]
    fn coordinator_moves_once_above_starred_and_archived_stays_put() {
        let c =
            Coordinator::decode(&json!({"projectId":"p","threadId":"t","state":"paused"})).unwrap();
        let thread = Arc::new(ThreadSummary {
            id: "t".to_owned(),
            ..Default::default()
        });
        let result = sections(
            vec![Section {
                key: "inbox",
                title: "Inbox",
                rows: vec![thread.clone()],
            }],
            std::slice::from_ref(&c),
        );
        assert_eq!(
            result.iter().map(|s| s.key).collect::<Vec<_>>(),
            ["coordinators", "inbox"]
        );
        assert_eq!(result[0].rows.len(), 1);
        assert!(result[1].rows.is_empty());
        let result = sections(
            vec![Section {
                key: "archived",
                title: "Archived",
                rows: vec![thread],
            }],
            &[c],
        );
        assert_eq!(result[0].key, "archived");
    }
}
