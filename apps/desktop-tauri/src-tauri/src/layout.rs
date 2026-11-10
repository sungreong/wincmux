use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
pub struct Split {
    direction: String,
    first: String,
    second: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Pane {
    pane_id: String,
    parent_id: Option<String>,
    split: Option<Split>,
    is_focused: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Layout {
    pub root_pane_id: String,
    panes: BTreeMap<String, Pane>,
}

impl Pane {
    fn leaf(id: String, parent_id: Option<String>, is_focused: bool) -> Self {
        Self {
            pane_id: id,
            parent_id,
            split: None,
            is_focused,
        }
    }
}

impl Default for Layout {
    fn default() -> Self {
        let root = Uuid::new_v4().to_string();
        let pane = Pane::leaf(root.clone(), None, true);
        Self {
            root_pane_id: root.clone(),
            panes: BTreeMap::from([(root, pane)]),
        }
    }
}

impl Layout {
    pub fn panes(&self) -> impl Iterator<Item = &Pane> {
        self.panes.values()
    }

    fn pane(&self, id: &str) -> Result<&Pane, String> {
        self.panes.get(id).ok_or_else(|| "pane not found".into())
    }

    fn pane_mut(&mut self, id: &str) -> Result<&mut Pane, String> {
        self.panes
            .get_mut(id)
            .ok_or_else(|| "pane not found".into())
    }

    fn leaf(&self, id: &str) -> Result<&Pane, String> {
        let pane = self.pane(id)?;
        if pane.split.is_some() {
            return Err("expected a leaf pane".into());
        }
        Ok(pane)
    }

    pub fn split(&mut self, id: &str, direction: &str) -> Result<[String; 2], String> {
        if !matches!(direction, "horizontal" | "vertical") {
            return Err("invalid split direction".into());
        }
        self.leaf(id)?;
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        let target = self.pane_mut(id)?;
        let focused = target.is_focused;
        target.is_focused = false;
        target.split = Some(Split {
            direction: direction.into(),
            first: first.clone(),
            second: second.clone(),
        });
        self.panes.insert(
            first.clone(),
            Pane::leaf(first.clone(), Some(id.into()), focused),
        );
        self.panes.insert(
            second.clone(),
            Pane::leaf(second.clone(), Some(id.into()), false),
        );
        Ok([first, second])
    }

    pub fn focus(&mut self, id: &str) -> Result<(), String> {
        self.pane(id)?;
        for pane in self.panes.values_mut() {
            pane.is_focused = pane.pane_id == id;
        }
        Ok(())
    }

    fn replace_child(&mut self, parent: Option<&str>, from: &str, to: &str) -> Result<(), String> {
        let Some(parent) = parent else {
            self.root_pane_id = to.into();
            return Ok(());
        };
        let split = self
            .pane_mut(parent)?
            .split
            .as_mut()
            .ok_or("invalid parent split state")?;
        if split.first == from {
            split.first = to.into();
        } else if split.second == from {
            split.second = to.into();
        } else {
            return Err("pane not linked from parent".into());
        }
        Ok(())
    }

    fn detach(&mut self, id: &str) -> Result<String, String> {
        let parent = self
            .leaf(id)?
            .parent_id
            .clone()
            .ok_or("cannot detach the last pane")?;
        let parent_pane = self.pane(&parent)?;
        let grandparent = parent_pane.parent_id.clone();
        let split = parent_pane
            .split
            .as_ref()
            .ok_or("invalid parent split state")?;
        let sibling = if split.first == id {
            split.second.clone()
        } else {
            split.first.clone()
        };
        self.replace_child(grandparent.as_deref(), &parent, &sibling)?;
        self.pane_mut(&sibling)?.parent_id = grandparent;
        self.pane_mut(id)?.parent_id = None;
        self.panes.remove(&parent);
        Ok(sibling)
    }

    pub fn close(&mut self, id: &str) -> Result<String, String> {
        let mut focus = self.detach(id)?;
        self.panes.remove(id);
        while let Some(split) = &self.pane(&focus)?.split {
            focus = split.first.clone();
        }
        self.focus(&focus)?;
        Ok(focus)
    }

    pub fn move_pane(&mut self, source: &str, target: &str, placement: &str) -> Result<(), String> {
        if source == target {
            return Ok(());
        }
        self.leaf(target)?;
        let (direction, source_first) = match placement {
            "left" => ("horizontal", true),
            "right" => ("horizontal", false),
            "above" => ("vertical", true),
            "below" => ("vertical", false),
            _ => return Err("invalid placement".into()),
        };
        self.detach(source)?;
        let parent = self.pane(target)?.parent_id.clone();
        let new_id = Uuid::new_v4().to_string();
        self.replace_child(parent.as_deref(), target, &new_id)?;
        let (first, second) = if source_first {
            (source, target)
        } else {
            (target, source)
        };
        self.panes.insert(
            new_id.clone(),
            Pane {
                pane_id: new_id.clone(),
                parent_id: parent,
                is_focused: false,
                split: Some(Split {
                    direction: direction.into(),
                    first: first.into(),
                    second: second.into(),
                }),
            },
        );
        self.pane_mut(source)?.parent_id = Some(new_id.clone());
        self.pane_mut(target)?.parent_id = Some(new_id);
        Ok(())
    }

    pub fn swap(&mut self, a: &str, b: &str) -> Result<(), String> {
        if a == b {
            return Ok(());
        }
        let pa = self
            .leaf(a)?
            .parent_id
            .clone()
            .ok_or("invalid root swap state")?;
        let pb = self
            .leaf(b)?
            .parent_id
            .clone()
            .ok_or("invalid root swap state")?;
        if pa == pb {
            let split = self
                .pane_mut(&pa)?
                .split
                .as_mut()
                .ok_or("invalid parent split state")?;
            std::mem::swap(&mut split.first, &mut split.second);
        } else {
            self.replace_child(Some(&pa), a, b)?;
            self.replace_child(Some(&pb), b, a)?;
            self.pane_mut(a)?.parent_id = Some(pb);
            self.pane_mut(b)?.parent_id = Some(pa);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_swap_move_and_close_preserve_leaf_ids() {
        let mut layout = Layout::default();
        let root = layout.root_pane_id.clone();
        let [a, b] = layout.split(&root, "horizontal").unwrap();
        layout.swap(&a, &b).unwrap();
        assert_eq!(layout.panes[&root].split.as_ref().unwrap().first, b);
        layout.move_pane(&a, &b, "above").unwrap();
        let parent = layout.panes[&layout.root_pane_id].split.as_ref().unwrap();
        assert_eq!((&parent.direction, &parent.first), (&"vertical".into(), &a));
        assert_eq!(layout.close(&a).unwrap(), b);
        assert_eq!(layout.root_pane_id, b);
        assert!(layout.panes[&b].is_focused);
        assert!(layout.close(&b).is_err());
    }
}
