use std::{
    collections::{hash_map::Entry, HashMap},
    fs::read_dir,
    path::{Path, PathBuf},
};

use anyhow::Result;
use highway::{HighwayHash, HighwayHasher, Key};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::{
    fs::read,
    io, spawn,
    sync::{
        broadcast::{self, error::SendError},
        mpsc, oneshot,
    },
    task::spawn_blocking,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Image {
    pub path: PathBuf,
}

enum Command {
    AddImage {
        hash: ImageHash,
        image: Image,
        response: oneshot::Sender<Result<(), IndexError>>,
    },
    GetIndex {
        response: oneshot::Sender<Vec<Image>>,
    },
}

pub struct Indexer {
    pub change_receiver: broadcast::Receiver<Change>,
    command_sender: mpsc::Sender<Command>,
}

impl Indexer {
    pub async fn spawn(directory: impl AsRef<Path>) -> Result<Self> {
        let directory = directory.as_ref().to_owned();
        let (change_sender, change_receiver) = broadcast::channel::<Change>(10);
        let (command_sender, mut command_receiver) = mpsc::channel(10);

        spawn({
            async move {
                let mut images = collect_images(&directory).await.unwrap();
                while let Some(command) = command_receiver.recv().await {
                    match command {
                        Command::AddImage {
                            hash,
                            image,
                            response,
                        } => match images.entry(hash) {
                            Entry::Vacant(entry) => {
                                entry.insert(image.clone());
                                change_sender.send(Change::Addition { image }).unwrap();
                                response.send(Ok(())).unwrap();
                            }
                            Entry::Occupied(entry) => {
                                response
                                    .send(Err(IndexError::Duplicate {
                                        path: entry.get().path.clone(),
                                    }))
                                    .unwrap();
                            }
                        },
                        Command::GetIndex { response } => {
                            response.send(images.values().cloned().collect()).unwrap();
                        }
                    }
                }
            }
        });
        Ok(Self {
            change_receiver,
            command_sender,
        })
    }

    pub async fn index(&self) -> Vec<Image> {
        let (sender, receiver) = oneshot::channel();
        self.command_sender
            .send(Command::GetIndex { response: sender })
            .await
            .unwrap();
        receiver.await.unwrap()
    }

    pub async fn add_image(&self, hash: ImageHash, image: Image) -> Result<(), IndexError> {
        let (sender, receiver) = oneshot::channel();
        self.command_sender
            .send(Command::AddImage {
                hash,
                image,
                response: sender,
            })
            .await
            .unwrap();
        receiver.await.unwrap()
    }
}

#[derive(Debug, Error)]
pub enum IndexError {
    #[error(transparent)]
    Internal(#[from] SendError<Change>),
    #[error("duplicate image {}", path.display())]
    Duplicate { path: PathBuf },
}

#[derive(Debug, Clone, Serialize)]
pub enum Change {
    Addition { image: Image },
}

pub type ImageHash = [u64; 2];

#[derive(Debug, Error)]
pub enum CollectionError {
    #[error(transparent)]
    Internal(#[from] SendError<Change>),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error("duplicate image {}", path.display())]
    Duplicate { path: PathBuf },
}

pub async fn collect_images(
    path: impl AsRef<Path>,
) -> Result<HashMap<ImageHash, Image>, CollectionError> {
    let entries = read_dir(&path)?;
    let mut images: HashMap<ImageHash, Image> = HashMap::new();
    for entry in entries {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            continue;
        }
        let hash = hash_file(entry.path()).await?;
        let stripped_path = entry.path().strip_prefix(&path).unwrap().to_path_buf();
        if images.contains_key(&hash) {
            return Err(CollectionError::Duplicate { path: entry.path() });
        }
        images.insert(
            hash,
            Image {
                path: stripped_path,
            },
        );
    }
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
