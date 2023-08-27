class Recommender {
  constructor(url) {
    this.url = url;
    this.nextIndex = 0;
  }
  async update() {
    const response = await fetch(this.url);
    this.images = await response.json();
    console.log(`Index contains ${this.images.length} images`);
  }
  next() {
    const index = this.nextIndex;
    this.nextIndex = (this.nextIndex + 1) % this.images.length;
    return this.images[index];
  }
}

class Column {
  constructor(element, recommender) {
    this.element = element;
    this.recommender = recommender;
    // this.scrollAnimation = new Animation(
    //   new KeyframeEffect(this.element.querySelector(".scroller")),
    //   document.timeline
    // );
  }
  removeOutOfViewport() {
    const images = this.element.querySelectorAll("img");
    for (let index = 0; index < images.length; ++index) {
      if (images[index].getBoundingClientRect().top > window.innerHeight) {
        this.element.removeChild(images[index]);
      }
    }
  }
  async fillColumn() {
    const currentHeight = () =>
      Array.from(this.element.querySelectorAll("img")).reduce(
        (sum, image, index) =>
          sum + (index > 2 ? image.getBoundingClientRect().height : 0),
        0
      );
    while (currentHeight() < window.innerHeight) {
      const image = this.element.appendChild(document.createElement("img"));
      await new Promise((resolve, reject) => {
        image.addEventListener("load", () => resolve());
        image.addEventListener("error", (error) => reject(error));
        image.src = new URL(
          `../images/${this.recommender.next().filename}`,
          window.location
        );
      });
      this.updatePositionAbsolute();
      this.updateScrollerMarginTop();
    }
    // console.log(images);
    // console.log(
    //   images[0],
    //   images[0].width,
    //   images[0].naturalWidth,
    //   images[0].height,
    //   images[0].naturalHeight
    // );
    // console.log(
    //   Array.from(images).reduce(
    //     (sum, image) => sum + image.getBoundingClientRect().height,
    //     0
    //   )
    // );
  }
  updatePositionAbsolute() {
    const images = this.element.querySelectorAll("img");
    for (let index = 0; index < images.length; ++index) {
      if (index === 0) {
        images[index].style.setProperty("top", "-200vh");
        images[index].style.setProperty("position", "absolute");
      } else {
        images[index].style.removeProperty("top");
        images[index].style.setProperty("position", "block");
      }
    }
  }
  updateScrollerMarginTop() {
    const images = this.element.querySelectorAll("img");
    if (images.length >= 2) {
      this.element
        .querySelector(".scroller")
        .style.setProperty(
          "margin-top",
          `${-images[1].getBoundingClientRect().height}px`
        );
    }
  }
}

const recommender = new Recommender(
  new URL("../images/index.json", window.location)
);
const column = new Column(document.querySelector(".column"), recommender);
(async () => {
  await recommender.update();
  column.removeOutOfViewport();
  await column.fillColumn();
})();

// class Image {
//   constructor(metadata) {
//     this.width = metadata.resolution.width;
//     this.height = metadata.resolution.height;
//     this.unitHeight = this.height / this.width;
//     this.element = document.body.appendChild(document.createElement("img"));
//     this.element.src = new URL(
//       `../images/${metadata.filename}`,
//       window.location
//     );
//     // this.element.style.display = "none";
//     this.element.onload = () => {
//       console.log("Loaded", this.element.src);
//     };
//     // this.animation = new Animation(
//     //   new KeyframeEffect(this.element, null),
//     //   document.timeline
//     // );
//   }
//   place(top, left, width) {
//     this.element.style.top = `${top}px`;
//     this.element.style.left = `${left}px`;
//     this.element.width = width;
//     this.element.height = width * this.unitHeight;
//   }
// }

// class Column {
//   constructor(left, width, recommender) {
//     this.left = left;
//     this.width = width;
//     this.preTop = this.recommender = recommender;
//     this.images = [];
//   }
//   update() {
//     const columnLeft = window.innerWidth * this.left;
//     const columnWidth = window.innerWidth * this.width;
//     let top = 0;
//     for (const image of this.images) {
//       image.place(top, columnLeft, columnWidth);
//       top += image.unitHeight * columnWidth;
//     }
//     while (top < window.innerHeight) {
//       const image = this.recommender.next();
//       image.place(top, columnLeft, columnWidth);
//       top += image.unitHeight * columnWidth;
//       this.images.push(image);
//     }
//     // this.prependRecommendedImagesUntilFull();
//   }
//   prependRecommendedImagesUntilFull() {
//     while (this.height() < window.innerHeight) {
//       console.log("prepending...", this.height(), "<", window.innerHeight);
//       const image = this.recommender.next();
//       image.setWidth(window.innerWidth * this.width);
//       this.images = [image, ...this.images];
//       console.log("prepended:", this.height(), "<", window.innerHeight);
//     }
//   }
//   height() {
//     return this.images.reduce((sum, image) => sum + image.element.height, 0);
//   }
// }

// const columns = [
//   new Column(0, 0.25, recommender),
//   new Column(0.25, 0.4, recommender),
//   new Column(0.65, 0.2, recommender),
//   new Column(0.85, 0.15, recommender),
// ];
// (async () => {
//   await recommender.update();
//   for (const column of columns) {
//     column.update();
//   }
// })();

// const image = document.body.appendChild(document.createElement("img"));
// image.src = "image.jpg";
// image.naturalWidth = 500;
// image.naturalHeight = 400;
// image.style.top = "0.5vw";
// image.style.left = "0.5vw";
// image.style.width = "39vw";
// image.style.height = `${(39 / 5) * 4}vw`;
// const animation = new Animation(
//   new KeyframeEffect(image, [{ top: "0.5vw" }, { top: "20vw" }], {
//     duration: 1000,
//     fill: "forwards",
//   }),
//   document.timeline
// );
// animation.finished.then(() => {
//   console.log("committing styles...");
//   animation.commitStyles();
// });
