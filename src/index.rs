use std::{
    collections::HashSet,
    hash::Hash,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::Result;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, Debouncer};
use serde::{Deserialize, Serialize};
use tokio::{
    select, spawn,
    sync::{broadcast, mpsc, oneshot, Notify},
};
use walkdir::WalkDir;

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct Index {
    images: HashSet<Image>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Image {
    pub path: PathBuf,
}

pub struct Indexer {
    pub changes: broadcast::Receiver<Changes>,
    index: mpsc::Sender<oneshot::Sender<Index>>,
}

impl Indexer {
    pub async fn spawn(directory: impl AsRef<Path>) -> Result<Self> {
        let directory = directory.as_ref().to_owned();
        let notifier = Arc::new(Notify::new());
        let (updates_sender, updates_receiver) = broadcast::channel(10);
        let (index_sender, mut index_receiver) = mpsc::channel::<oneshot::Sender<Index>>(10);
        let watcher = watch_file_system(&directory, notifier.clone()).await?;

        spawn(async move {
            let _watcher = watcher; // keep watcher alive
            let mut images = collect_images(&directory).unwrap();
            loop {
                select! {
                    Some(sender) = index_receiver.recv() => {
                        sender.send(Index { images: images.clone() }).unwrap();
                    }
                    _ = notifier.notified() => {
                        let new_images = collect_images(&directory).unwrap();
                        let changes = compute_changes(&images, &new_images);
                        if !changes.is_empty() {
                            updates_sender.send(changes).unwrap();
                        }
                        images = new_images;
                    }
                }
            }
        });
        Ok(Self {
            changes: updates_receiver,
            index: index_sender,
        })
    }

    pub async fn index(&self) -> Index {
        let (sender, receiver) = oneshot::channel();
        self.index.send(sender).await.unwrap();
        receiver.await.unwrap()
    }
}

async fn watch_file_system(
    path: impl AsRef<Path>,
    notifier: Arc<Notify>,
) -> Result<Debouncer<RecommendedWatcher>, notify::Error> {
    let mut debouncer = new_debouncer(Duration::from_secs(1), {
        move |result| match result {
            Ok(_) => {
                notifier.notify_one();
            }
            Err(error) => eprintln!("watch error {error:?}"),
        }
    })?;

    debouncer
        .watcher()
        .watch(path.as_ref(), RecursiveMode::Recursive)?;
    Ok(debouncer)
}

#[derive(Debug, Clone, Serialize)]
pub struct Changes {
    pub additions: Vec<Image>,
    pub deletions: Vec<Image>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.additions.is_empty() && self.deletions.is_empty()
    }
}

fn compute_changes(old: &HashSet<Image>, new: &HashSet<Image>) -> Changes {
    let additions = new.difference(old).cloned().collect();
    let deletions = old.difference(new).cloned().collect();
    Changes {
        additions,
        deletions,
    }
}

pub fn collect_images(path: impl AsRef<Path>) -> Result<HashSet<Image>, walkdir::Error> {
    // TODO: walkdir is not async
    let walker = WalkDir::new(&path).into_iter();
    let entries = walker
        .filter_entry(|entry| {
            entry.file_type().is_dir()
                || entry.file_type().is_file()
                    && entry
                        .path()
                        .extension()
                        .map(|extension| extension.to_ascii_lowercase())
                        .is_some_and(|extension| {
                            extension == "jpg" || extension == "jpeg" || extension == "png"
                        })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut images = HashSet::with_capacity(entries.len());
    for entry in &entries {
        if entry.file_type().is_dir() {
            continue;
        }

        images.insert(Image {
            path: entry.path().strip_prefix(&path).unwrap().to_path_buf(),
        });
    }
    Ok(images)
}
