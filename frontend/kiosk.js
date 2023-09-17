if (!window.location.hash) {
  const newHash = prompt("Please enter the event's secret");
  if (newHash !== null) {
    window.location.hash = `#${newHash}`;
  }
}

const baseDuration = 1250;
const options = {
  highlightScale: 1.5,
  popUpDuration: baseDuration,
  highlightDuration: baseDuration * 5,
  popDownDuration: baseDuration * 0.75,
  allowedRelativeWidthFromCenterForAdditions: 0.4, // from center in one direction, so actually twice
  easing: "cubic-bezier(0.65, 0.05, 0.36, 1)",
  amountOfRows: 5,
  stopIteration: false,
  secret: window.location.hash.substring(1),
};

class Recommender {
  constructor(url) {
    this.images = {};
    this.sortedImages = [];
    this.imagesReceived = new Promise((resolve) => {
      this.resolveImagesReceived = resolve;
    });
    this.webSocket = new WebSocket(url);
    this.webSocket.addEventListener("close", () => {
      alert("Server connection disconnected, please reload");
    });
    this.webSocket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      console.log(message);
      if (typeof message.images === "object") {
        for (const image of message.images) {
          this.images[image.path] = image.modified;
        }
        this.sortedImages = Array.from(Object.keys(this.images)).toSorted();
        this.resolveImagesReceived();
      } else if (
        typeof message.additions === "object" &&
        typeof message.deletions === "object"
      ) {
        for (const image of message.additions) {
          this.images[image.path] = image.modified;
        }
        for (const image of message.deletions) {
          delete this.images[image.path];
        }
        this.sortedImages = Array.from(Object.keys(this.images)).toSorted();
      } else {
        console.error(`Unexpected message ${message}`);
      }
    });
  }
  next() {
    return this.sortedImages[
      Math.floor(Math.random() * this.sortedImages.length)
    ];
  }
}

(async () => {
  if (!options.secret) {
    throw new Error("No secret provided");
  }

  const recommenderUrl = new URL(
    `./images/${options.secret}/index`,
    window.location
  );
  recommenderUrl.protocol =
    recommenderUrl.protocol === "http:" ? "ws:" : "wss:";
  const recommender = new Recommender(recommenderUrl);
  await recommender.imagesReceived;
  const rows = Array.from({ length: options.amountOfRows }, () => {
    const row = document.body.appendChild(document.createElement("div"));
    row.classList.add("row");
    return row;
  });
  document.body.style.setProperty(
    "grid-template-rows",
    Array.from(
      { length: options.amountOfRows },
      () => `${100 / options.amountOfRows}vh`
    ).join(" ")
  );
  await addImagesUntilScreenIsFull(options, rows, recommender);
  while (!options.stopIteration) {
    await addImage(options, rows, recommender);
  }
})();

async function addImagesUntilScreenIsFull(options, rows, recommender) {
  for (const selectedRow of rows) {
    while (true) {
      const imagesInRow = Array.from(selectedRow.querySelectorAll("img"));
      const widthOfRow = imagesInRow.reduce((sum, image) => {
        const boundingRect = image.getBoundingClientRect();
        return sum + boundingRect.width;
      }, 0);
      if (widthOfRow >= window.innerWidth) {
        break;
      }

      const image = await loadAndInsertImage(
        options,
        selectedRow,
        imagesInRow,
        recommender
      );
      resetStyle(image);
    }
  }
}

async function addImage(options, rows, recommender) {
  if (options.allowedRelativeWidthFromCenterForAdditions >= 0.5) {
    throw new Error(
      `options.allowedRelativeWidthFromCenterForAdditions >= 0.5, ${{
        options,
        rows,
      }}`
    );
  }

  const selectedRow = rows[Math.floor(Math.random() * rows.length)];
  const imagesInRow = Array.from(selectedRow.querySelectorAll("img"));

  const image = await loadAndInsertImage(
    options,
    selectedRow,
    imagesInRow,
    recommender
  );
  const width = (20 / image.naturalHeight) * image.naturalWidth;
  await animatePopUp(options, image, width);
  await sleep(options.highlightDuration);
  await Promise.all([
    animatePopDown(options, image, width),
    removeOutOfViewportImages(options, selectedRow),
  ]);
  resetStyle(image);
}

async function loadAndInsertImage(
  options,
  selectedRow,
  imagesInRow,
  recommender
) {
  let image = null;
  if (imagesInRow.length > 0) {
    const viewportWidth = window.innerWidth;
    const imagesWithSpaceLeft = imagesInRow.filter((image) => {
      const left = image.getBoundingClientRect().left;
      const relativeWidth = options.allowedRelativeWidthFromCenterForAdditions;
      return (
        left >= (0.5 - relativeWidth) * viewportWidth &&
        left <= (0.5 + relativeWidth) * viewportWidth
      );
    });
    if (imagesWithSpaceLeft.length === 0) {
      throw new Error(
        `${{
          options,
          selectedRow,
          imagesInRow,
          viewportWidth,
          imagesWithSpaceLeft,
        }}`
      );
    }
    const imageWithSpaceLeft =
      imagesWithSpaceLeft[
        Math.floor(Math.random() * imagesWithSpaceLeft.length)
      ];
    image = selectedRow.insertBefore(
      document.createElement("img"),
      imageWithSpaceLeft
    );
  } else {
    image = selectedRow.appendChild(document.createElement("img"));
  }
  image.style.setProperty("box-shadow", "none");
  image.style.setProperty("margin", "0 0");
  image.style.setProperty("transform", "none");
  image.style.setProperty("width", "0");
  image.style.setProperty("z-index", "1");

  await new Promise((resolve, reject) => {
    image.addEventListener("load", () => resolve());
    image.addEventListener("error", (error) => reject(error));
    image.src = new URL(
      `./images/${options.secret}/${recommender.next()}`,
      window.location
    );
  });

  // rect without scaling
  const imageRectAfterAnimations = image.getBoundingClientRect();
  const width =
    (imageRectAfterAnimations.height / image.naturalHeight) *
    image.naturalWidth;
  imageRectAfterAnimations.x -= width / 2;
  imageRectAfterAnimations.width = width;

  // scaled rect
  const scaledWidth = imageRectAfterAnimations.width * options.highlightScale;
  const scaledHeight = imageRectAfterAnimations.height * options.highlightScale;
  imageRectAfterAnimations.x -=
    (scaledWidth - imageRectAfterAnimations.width) / 2;
  imageRectAfterAnimations.width = scaledWidth;
  imageRectAfterAnimations.y -=
    (scaledHeight - imageRectAfterAnimations.height) / 2;
  imageRectAfterAnimations.height = scaledHeight;

  // changing transform origin
  let verticalOrigin = "center";
  if (imageRectAfterAnimations.top < 0) {
    verticalOrigin = "top";
  } else if (imageRectAfterAnimations.bottom > window.innerHeight) {
    verticalOrigin = "bottom";
  }
  let horizontalOrigin = "center";
  if (imageRectAfterAnimations.left < 0) {
    horizontalOrigin = "left";
  } else if (imageRectAfterAnimations.right > window.innerWidth) {
    horizontalOrigin = "right";
  }
  image.style.setProperty(
    "transform-origin",
    `${verticalOrigin} ${horizontalOrigin}`
  );

  return image;
}

async function animatePopUp(options, image, width) {
  const animation = image.animate(
    [
      {
        boxShadow: "0 0 1cm transparent",
        margin: "0 0",
        transform: "none",
        width: "0",
      },
      {
        boxShadow: "0 0 1cm #000000",
        margin: "0 0.0625cm",
        transform: `scale(${options.highlightScale})`,
        width: `${width}vh`,
      },
    ],
    {
      duration: options.popUpDuration,
      fill: "forwards",
      easing: options.easing,
    }
  );
  await animation.finished;
  animation.commitStyles();
}

async function animatePopDown(options, image, width) {
  const animation = image.animate(
    [
      {
        boxShadow: "0 0 1cm #000000",
        transform: `scale(${options.highlightScale})`,
        width: `${width}vh`,
      },
      {
        boxShadow: "0 0 1cm transparent",
        transform: "none",
        width: `${width}vh`,
      },
    ],
    {
      duration: options.popDownDuration,
      fill: "forwards",
      easing: options.easing,
    }
  );
  await animation.finished;
  animation.commitStyles();
}

async function removeOutOfViewportImages(options, selectedRow) {
  const imagesOutOfViewport = Array.from(
    selectedRow.querySelectorAll("img")
  ).filter((image) => {
    const boundingRect = image.getBoundingClientRect();
    return boundingRect.right < 0 || boundingRect.left > window.innerWidth;
  });

  const animations = imagesOutOfViewport.map((image) => {
    const width = image.getBoundingClientRect().width;
    return image.animate([{ width: `${width}px` }, { width: "0" }], {
      duration: options.popDownDuration,
      fill: "forwards",
      easing: options.easing,
    });
  });
  for (const animation of animations) {
    await animation.finished;
    animation.commitStyles();
  }

  for (const image of imagesOutOfViewport) {
    selectedRow.removeChild(image);
  }
}

function resetStyle(image) {
  image.style.removeProperty("box-shadow");
  image.style.removeProperty("margin");
  image.style.removeProperty("transform");
  image.style.removeProperty("transform-origin");
  image.style.removeProperty("width");
  image.style.removeProperty("z-index");
}

function sleep(duration) {
  return new Promise((resolve) => setTimeout(resolve, duration));
}
