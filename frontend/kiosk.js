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

class AwaitableCondition {
  constructor(conditionPredicate) {
    this.conditionPredicate = conditionPredicate;
    this.resolves = [];
    this.isSet = false;
  }
  notifyOne() {
    if (this.conditionPredicate()) {
      const nextResolve = this.resolves.shift();
      if (nextResolve !== undefined) {
        nextResolve();
      }
    }
  }
  wait() {
    return new Promise((resolve) => {
      if (this.conditionPredicate()) {
        resolve();
        return;
      }
      this.resolves.push(resolve);
    });
  }
}

class Bucket {
  constructor() {
    this.items = {};
  }
  add(key, value) {
    this.items[key] = value;
  }
  delete(key) {
    delete this.items[key];
  }
  contains(key) {
    return key in this.items;
  }
  get length() {
    return Array.from(Object.keys(this.items)).length;
  }
  popRandom() {
    // we don't have any order requirement on the keys because we will randomly select anyway
    const keys = Array.from(Object.keys(this.items));
    if (keys.length === 0) {
      return undefined;
    }
    const key = keys[Math.floor(Math.random() * keys.length)];
    const value = this.items[key];
    delete this.items[key];
    return [key, value];
  }
}

class Recommender {
  constructor(url) {
    this.notYetShown = new Bucket();
    this.alreadyShown = new Bucket();
    this.currentlyShowing = new Bucket();
    this.imagesAvailable = new AwaitableCondition(
      () => this.notYetShown.length > 0 || this.alreadyShown.length > 0
    );

    this.webSocket = new WebSocket(url);
    this.webSocket.addEventListener("close", () => {
      alert("Server connection disconnected, please reload");
    });
    this.webSocket.addEventListener("message", (event) => {
      this.#handleMessage(JSON.parse(event.data));
    });
  }
  #handleMessage(message) {
    console.log("message", message);
    if (typeof message.images === "object") {
      for (const image of message.images) {
        this.alreadyShown.add(image.path, image.modified);
        this.imagesAvailable.notifyOne();
      }
    } else if (
      typeof message.additions === "object" &&
      typeof message.deletions === "object"
    ) {
      for (const image of message.additions) {
        this.notYetShown.add(image.path, image.modified);
        this.imagesAvailable.notifyOne();
      }
      for (const image of message.deletions) {
        this.notYetShown.delete(image.path);
        this.alreadyShown.delete(image.path);
        this.currentlyShowing.delete(image.path);
      }
    } else {
      console.error(`Unexpected message ${message}`);
    }
  }
  async prolaag() {
    await this.imagesAvailable.wait();

    // console.log(
    //   this.notYetShown.length,
    //   this.alreadyShown.length,
    //   this.currentlyShowing.length
    // );

    let image = this.notYetShown.popRandom();
    if (image !== undefined) {
      this.currentlyShowing.add(image[0], image[1]);
      return { path: image[0], modified: image[1] };
    }

    image = this.alreadyShown.popRandom();
    if (image !== undefined) {
      this.currentlyShowing.add(image[0], image[1]);
      return { path: image[0], modified: image[1] };
    }
  }
  verhoog(image) {
    this.currentlyShowing.delete(image.path);
    this.alreadyShown.add(image.path, image.modified);
    this.imagesAvailable.notifyOne();
  }
}

(async () => {
  if (!options.secret) {
    throw new Error("No secret provided");
  }

  const recommenderUrl = new URL(`./index/${options.secret}`, window.location);
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
    `repeat(${options.amountOfRows}, calc(${
      100 / options.amountOfRows
    }vh - 0.125cm))`
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
    removeOutOfViewportImages(options, selectedRow, recommender),
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

  const recommendedImage = await recommender.prolaag();
  image.setAttribute("data-metadata", JSON.stringify(recommendedImage));

  await new Promise((resolve, reject) => {
    image.addEventListener("load", () => resolve());
    image.addEventListener("error", (error) => {
      console.log(recommendedImage, error);
      reject(error);
    });
    // console.log(recommendedImage);
    image.src = new URL(
      `./images/${options.secret}/${recommendedImage.path}`,
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
        boxShadow: `0 0 1cm #000000, 0 0 0 ${
          1 / options.highlightScale
        }px rgba(0, 0, 0, 0.25)`,
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

async function removeOutOfViewportImages(options, selectedRow, recommender) {
  const imagesOutOfViewport = Array.from(
    selectedRow.querySelectorAll("img")
  ).filter((image) => {
    const boundingRect = image.getBoundingClientRect();
    return boundingRect.right < 0 || boundingRect.left > window.innerWidth;
  });

  const animations = imagesOutOfViewport.map((image) => {
    const width = image.getBoundingClientRect().width;
    return image.animate(
      [
        { margin: "0 0.0625cm", width: `${width}px` },
        { margin: "0 0", width: "0" },
      ],
      {
        duration: options.popDownDuration,
        fill: "forwards",
        easing: options.easing,
      }
    );
  });
  for (const animation of animations) {
    await animation.finished;
    animation.commitStyles();
  }

  for (const image of imagesOutOfViewport) {
    recommender.verhoog(JSON.parse(image.getAttribute("data-metadata")));
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
