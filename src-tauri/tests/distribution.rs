//! The desktop-distribution contracts that have no window to look at: which
//! `grove://` links navigate where, the menu id table both sides bind to, and
//! which global shortcuts are accepted.
//!
//! Ways these fail, written before the code:
//! - a link with an unencoded path splits into the wrong project/file;
//! - a file segment with `..` or a leading `/` steers the webview out of the
//!   project; bad percent-encoding or a query/fragment is read as a path;
//! - an unregistered project is reported as registered (or registered);
//! - a registered project whose directory is gone, or that is named through a
//!   symlink, is reported as unregistered;
//! - the menu layout and `MENU_ITEM_IDS` drift, an id repeats, or the TypeScript
//!   union stops matching, so a menu click reaches no handler;
//! - an accelerator does not parse, which fails the whole menu at startup;
//! - a global shortcut without Command/Control/Option is accepted and then
//!   fires system-wide while typing.

use std::path::PathBuf;
use std::str::FromStr;

use grove_lib::deep_link::{parse_deep_link, resolve_navigation, DeepLinkTarget, Navigation};
use grove_lib::menu::{layout_item_ids, MenuEntry, MENU_BAR, MENU_ITEM_IDS};
use grove_lib::shortcut::{parse_global_shortcut, DEFAULT_GLOBAL_SHORTCUT};

fn target(project: &str, file: Option<&str>) -> DeepLinkTarget {
    DeepLinkTarget {
        project: project.to_string(),
        file: file.map(str::to_string),
    }
}

#[test]
fn deep_link_decodes_project_and_file_segments() {
    assert_eq!(
        parse_deep_link("grove://project/%2FUsers%2Fme%2Fmy%20repo"),
        Ok(target("/Users/me/my repo", None))
    );
    assert_eq!(
        parse_deep_link("grove://project/%2Fsrv%2Fgrove/file/src%2Fqueries.ts"),
        Ok(target("/srv/grove", Some("src/queries.ts")))
    );
    assert_eq!(
        parse_deep_link("grove://project/%2Fsrv%2Fb%C3%A4ume/file/%3F.md"),
        Ok(target("/srv/bäume", Some("?.md")))
    );
}

#[test]
fn deep_link_rejects_links_that_do_not_name_one_place() {
    let rejected = [
        "grove://settings",
        "https://project/%2Fsrv%2Fgrove",
        "grove://project/",
        "grove://project//srv/grove",
        "grove://project/%2Fsrv%2Fgrove/",
        "grove://project/%2Fsrv%2Fgrove/files/a.ts",
        "grove://project/%2Fsrv%2Fgrove/file/",
        "grove://project/%2Fsrv%2Fgrove/file/a.ts/extra",
        "grove://project/%2Fsrv%2Fgrove?x=1",
        "grove://project/%2Fsrv%2Fgrove/file/a.ts#L3",
        "grove://project/srv%2Fgrove",
        "grove://project/%2Fsrv%2Fgrove/file/..%2F..%2Fetc%2Fpasswd",
        "grove://project/%2Fsrv%2Fgrove/file/%2Fetc%2Fpasswd",
        "grove://project/%2Fsrv%2Fgrove/file/.%2Fa.ts",
        "grove://project/%2Fsrv%2F%FF",
        "grove://project/%2Fsrv%00",
    ];
    for url in rejected {
        assert!(parse_deep_link(url).is_err(), "{url} was accepted");
    }
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let root = std::env::temp_dir().join(format!("grove-links-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("repo")).expect("scratch repo");
        Scratch(root)
    }

    fn path(&self, relative: &str) -> String {
        self.0.join(relative).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn deep_link_reports_registration_without_registering() {
    let scratch = Scratch::new("registration");
    let repo = std::fs::canonicalize(scratch.path("repo"))
        .expect("canonical repo")
        .to_string_lossy()
        .into_owned();
    std::os::unix::fs::symlink(&repo, scratch.path("alias")).expect("symlink");
    let gone = scratch.path("gone");
    let registered = vec![repo.clone(), gone.clone()];

    // Through a symlink: the stored path comes back, so the webview's identity holds.
    let via_alias = resolve_navigation(target(&scratch.path("alias"), Some("a.ts")), &registered);
    assert_eq!(
        via_alias,
        Navigation {
            project: repo.clone(),
            file: Some("a.ts".to_string()),
            registered: true,
        }
    );

    // A registered project whose directory is gone still matches verbatim.
    assert!(resolve_navigation(target(&gone, None), &registered).registered);

    // A sibling that merely shares a prefix is not the project.
    let sibling = format!("{repo}-other");
    let unregistered = resolve_navigation(target(&sibling, None), &registered);
    assert_eq!(unregistered.project, sibling);
    assert!(!unregistered.registered);
}

#[test]
fn menu_layout_emits_exactly_the_id_table() {
    assert_eq!(layout_item_ids(MENU_BAR), MENU_ITEM_IDS.to_vec());
    let mut unique = MENU_ITEM_IDS.to_vec();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), MENU_ITEM_IDS.len(), "an id repeats");
}

#[test]
fn menu_ids_match_the_typescript_union() {
    let source = include_str!("../../src/types/menu.ts");
    let start = source
        .find("MENU_ITEM_IDS = [")
        .expect("MENU_ITEM_IDS in menu.ts");
    let end = start
        + source[start..]
            .find("] as const")
            .expect("end of MENU_ITEM_IDS");
    let typescript: Vec<&str> = source[start..end]
        .lines()
        .skip(1)
        .map(|line| line.trim().trim_end_matches(',').trim_matches('"'))
        .filter(|id| !id.is_empty())
        .collect();
    assert_eq!(typescript, MENU_ITEM_IDS.to_vec());
}

fn accelerators(entries: &[MenuEntry]) -> Vec<&'static str> {
    entries
        .iter()
        .flat_map(|entry| match entry {
            MenuEntry::Item {
                accelerator: Some(accelerator),
                ..
            } => vec![*accelerator],
            MenuEntry::Submenu { entries, .. } => accelerators(entries),
            _ => Vec::new(),
        })
        .collect()
}

#[test]
fn menu_accelerators_parse_and_never_repeat() {
    let all = accelerators(MENU_BAR);
    for accelerator in &all {
        let parsed = muda::accelerator::Accelerator::from_str(accelerator);
        assert!(parsed.is_ok(), "{accelerator}: {parsed:?}");
    }
    let mut unique = all.clone();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), all.len(), "two items share an accelerator");
}

#[test]
fn global_shortcut_needs_an_anchoring_modifier() {
    for accepted in [
        DEFAULT_GLOBAL_SHORTCUT,
        "Cmd+Shift+G",
        "Alt+Space",
        " Ctrl+F12 ",
    ] {
        assert!(
            parse_global_shortcut(accepted).is_ok(),
            "{accepted} was rejected"
        );
    }
    for rejected in ["", "G", "Shift+G", "Cmd+", "Cmd+Shift+NotAKey", "Hyper+G"] {
        assert!(
            parse_global_shortcut(rejected).is_err(),
            "{rejected} was accepted"
        );
    }
}
