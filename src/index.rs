use std::{
    collections::HashSet,
    hash::Hash,
    io,
    path::{Path, PathBuf},
};

use anyhow::Result;
use highway::{HighwayHash, HighwayHasher, Key};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::{
    fs::{self, read, read_dir},
    io, select, spawn,
    sync::{
        broadcast::{self, error::SendError},
        mpsc, oneshot,
    },
    task::spawn_blocking,
};
use walkdir::WalkDir;

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct Index {
    images: HashSet<Image>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Image {
    pub path: PathBuf,
    pub hash: [u64; 2],
}

pub struct Indexer {
    change_sender: broadcast::Sender<Change>,
    pub change_receiver: broadcast::Receiver<Change>,
    index: mpsc::Sender<oneshot::Sender<Index>>,
}

impl Indexer {
    pub async fn spawn(directory: impl AsRef<Path>) -> Result<Self> {
        let directory = directory.as_ref().to_owned();
        let (change_sender, change_receiver) = broadcast::channel::<Change>(10);
        let (index_sender, mut index_receiver) = mpsc::channel::<oneshot::Sender<Index>>(10);

        spawn({
            let mut change_receiver = change_receiver.resubscribe();
            async move {
                let mut images = collect_images(&directory).unwrap();
                loop {
                    select! {
                        Some(sender) = index_receiver.recv() => {
                            sender.send(Index { images: images.clone() }).unwrap();
                        }
                        Ok(change) = change_receiver.recv() => {
                            match change {
                                Change::Addition { image } => {
                                    images.insert(image);
                                }
                            }
                        }
                    }
                }
            }
        });
        Ok(Self {
            change_sender,
            change_receiver,
            index: index_sender,
        })
    }

    pub async fn index(&self) -> Index {
        let (sender, receiver) = oneshot::channel();
        self.index.send(sender).await.unwrap();
        receiver.await.unwrap()
    }

    pub fn add_image(&self, image: Image) -> Result<(), IndexError> {
        self.change_sender.send(Change::Addition { image })?;
        Ok(())
    }
}

#[derive(Debug, Error)]
pub enum IndexError {
    #[error(transparent)]
    Internal(#[from] SendError<Change>),
    #[error("duplicate image")]
    Duplicate,
}

#[derive(Debug, Clone, Serialize)]
pub enum Change {
    Addition { image: Image },
}

#[derive(Debug, Error)]
pub enum CollectionError {
    #[error(transparent)]
    Internal(#[from] SendError<Change>),
    #[error("duplicate image")]
    Duplicate,
}

pub async fn collect_images(path: impl AsRef<Path>) -> Result<HashSet<Image>, io::Error> {
    let paths = read_dir(&path).await?;
    let images = paths
        .filter_map(|entry| match entry {
            Ok(entry) if entry.file_type().is_dir() => None,
            Ok(entry) => {
                let hash = hash_file(entry.path())?;
                let stripped_path = entry.path().strip_prefix(&path).unwrap().to_path_buf();
                Some(Ok(Image {
                    path: stripped_path,
                }))
            }
            Err(error) => Some(Err(error)),
        })
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(images)
}

pub async fn hash_file(path: impl AsRef<Path>) -> Result<[u64; 2], io::Error> {
    let key = Key([1, 3, 3, 7]);
    let mut hasher = HighwayHasher::new(key);
    let bytes = read(&path).await?;
    hasher.append(&bytes);
    let hash = spawn_blocking(move || hasher.finalize128()).await.unwrap();
    Ok(hash)
}
