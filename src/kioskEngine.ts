import { ImmichService } from "./immichService";
import type { KioskAsset } from "./types";

interface KioskOptions {
  highlightScale: number;
  popUpDuration: number;
  highlightDuration: number;
  popDownDuration: number;
  allowedRelativeWidthFromCenterForAdditions: number;
  easing: string;
  numberOfRows: number;
}

const baseDuration = 1250;

export const DefaultOptions: KioskOptions = {
  highlightScale: 1.5,
  popUpDuration: baseDuration,
  highlightDuration: baseDuration * 5,
  popDownDuration: baseDuration * 0.75,
  allowedRelativeWidthFromCenterForAdditions: 0.4,
  easing: "cubic-bezier(0.65, 0.05, 0.36, 1)",
  numberOfRows: 5,
};

export class KioskEngine {
  private options: KioskOptions;
  private service: ImmichService;
  private isRunning = false;
  // Store rows as a class property to avoid redeclaration issues
  private rowElements: HTMLDivElement[] = [];

  constructor(service: ImmichService, options: KioskOptions = DefaultOptions) {
    this.service = service;
    this.options = options;
  }

  public async start() {
    this.isRunning = true;
    this.setupGrid();

    // Wait for at least one image to exist
    while (!this.service.hasContent()) {
      await this.sleep(500);
    }

    // Initial Fill: Fill the screen with historical images
    await this.fillScreen();

    // Main Loop: Add new images one by one with animation
    while (this.isRunning) {
      try {
        await this.processNextIteration();
      } catch (error) {
        console.error("Error in main loop:", error);
        await this.sleep(1000);
      }
    }
  }

  public stop() {
    this.isRunning = false;
  }

  private setupGrid() {
    document.body.innerHTML = '';
    this.rowElements = Array.from({ length: this.options.numberOfRows }, () => {
      const row = document.createElement("div");
      row.classList.add("row");
      document.body.appendChild(row);
      return row;
    });

    document.body.style.setProperty(
      "grid-template-rows",
      `repeat(${this.options.numberOfRows}, calc(${100 / this.options.numberOfRows}vh - 0.125cm))`
    );
  }

  private async fillScreen() {
    for (const selectedRow of this.rowElements) {
      // Try to fill row until width > viewport
      while (this.isRunning) {
        const imagesInRow = Array.from(selectedRow.querySelectorAll("img"));
        const widthOfRow = imagesInRow.reduce((sum, img) => sum + img.getBoundingClientRect().width, 0);

        if (widthOfRow >= window.innerWidth) break;

        try {
          const imgElement = await this.loadAndInsertImage(selectedRow, imagesInRow);
          // For initial fill, we don't want the "pop" animation state left over
          if (imgElement) this.resetStyle(imgElement);
        } catch (e) {
          // Break inner loop if loading fails or no assets
          break;
        }
      }
    }
  }

  private async processNextIteration() {
    if (this.options.allowedRelativeWidthFromCenterForAdditions >= 0.5) {
      throw new Error("Allowed width too large");
    }

    const selectedRow = this.rowElements[Math.floor(Math.random() * this.rowElements.length)];
    const imagesInRow = Array.from(selectedRow.querySelectorAll("img"));

    const image = await this.loadAndInsertImage(selectedRow, imagesInRow);
    if (!image) {
      // No image loaded (maybe empty queue), wait a bit
      await this.sleep(500);
      return;
    }

    // Calculate target width based on 20vh reference logic
    const width = (20 / image.naturalHeight) * image.naturalWidth;

    await this.animatePopUp(image, width);
    await this.sleep(this.options.highlightDuration);

    await Promise.all([
      this.animatePopDown(image, width),
      this.removeOutOfViewportImages(selectedRow),
    ]);

    this.resetStyle(image);
  }

  private async loadAndInsertImage(
    row: HTMLDivElement,
    imagesInRow: HTMLImageElement[]
  ): Promise<HTMLImageElement | null> {

    let imgElement: HTMLImageElement;

    // Insertion Logic
    if (imagesInRow.length > 0) {
      const viewportWidth = window.innerWidth;
      const validSiblings = imagesInRow.filter((img) => {
        const left = img.getBoundingClientRect().left;
        const rel = this.options.allowedRelativeWidthFromCenterForAdditions;
        return (
          left >= (0.5 - rel) * viewportWidth &&
          left <= (0.5 + rel) * viewportWidth
        );
      });

      if (validSiblings.length === 0) return null;

      const sibling = validSiblings[Math.floor(Math.random() * validSiblings.length)];
      imgElement = document.createElement("img");
      row.insertBefore(imgElement, sibling);
    } else {
      imgElement = document.createElement("img");
      row.appendChild(imgElement);
    }

    // Initialize styles
    imgElement.style.boxShadow = "none";
    imgElement.style.margin = "0 0";
    imgElement.style.transform = "none";
    imgElement.style.width = "0";
    imgElement.style.zIndex = "1";

    // Data Fetching
    const asset: KioskAsset | undefined = await this.service.getNextImage();
    if (!asset) {
      imgElement.remove();
      return null;
    }

    try {
      const blobUrl = await this.service.fetchImageBlob(asset);
      imgElement.src = blobUrl;

      // Tag element for cleanup later
      imgElement.dataset.blobUrl = blobUrl;

      await new Promise<void>((resolve, reject) => {
        imgElement.onload = () => resolve();
        imgElement.onerror = (e) => reject(e);
      });
    } catch (e) {
      imgElement.remove();
      return null;
    }

    // Calculate Transform Origin
    const rect = imgElement.getBoundingClientRect();
    const targetWidth = (rect.height / imgElement.naturalHeight) * imgElement.naturalWidth;
    const scaledWidth = targetWidth * this.options.highlightScale;
    const scaledHeight = rect.height * this.options.highlightScale;

    const virtualTop = rect.y - (scaledHeight - rect.height) / 2;
    const virtualBottom = rect.bottom + (scaledHeight - rect.height) / 2;
    const virtualLeft = rect.x - (scaledWidth - targetWidth) / 2;
    const virtualRight = rect.right + (scaledWidth - targetWidth) / 2;

    let vOrigin = "center";
    if (virtualTop < 0) vOrigin = "top";
    else if (virtualBottom > window.innerHeight) vOrigin = "bottom";

    let hOrigin = "center";
    if (virtualLeft < 0) hOrigin = "left";
    else if (virtualRight > window.innerWidth) hOrigin = "right";

    imgElement.style.transformOrigin = `${vOrigin} ${hOrigin}`;

    return imgElement;
  }

  private async animatePopUp(image: HTMLImageElement, widthVh: number) {
    const animation = image.animate(
      [
        {
          boxShadow: "0 0 1cm transparent",
          margin: "0 0",
          transform: "none",
          width: "0",
        },
        {
          boxShadow: `0 0 1cm #000000, 0 0 0 ${1 / this.options.highlightScale}px rgba(0, 0, 0, 0.25)`,
          margin: "0 0.0625cm",
          transform: `scale(${this.options.highlightScale})`,
          width: `${widthVh}vh`,
        },
      ],
      {
        duration: this.options.popUpDuration,
        fill: "forwards",
        easing: this.options.easing,
      }
    );
    await animation.finished;
    animation.commitStyles();
  }

  private async animatePopDown(image: HTMLImageElement, widthVh: number) {
    const animation = image.animate(
      [
        {
          boxShadow: "0 0 1cm #000000",
          transform: `scale(${this.options.highlightScale})`,
          width: `${widthVh}vh`,
        },
        {
          boxShadow: "0 0 1cm transparent",
          transform: "none",
          width: `${widthVh}vh`,
        },
      ],
      {
        duration: this.options.popDownDuration,
        fill: "forwards",
        easing: this.options.easing,
      }
    );
    await animation.finished;
    animation.commitStyles();
  }

  private async removeOutOfViewportImages(row: HTMLDivElement) {
    const images = Array.from(row.querySelectorAll("img"));
    const outOfView = images.filter(img => {
      const rect = img.getBoundingClientRect();
      return rect.right < 0 || rect.left > window.innerWidth;
    });

    const promises = outOfView.map(async (img) => {
      const width = img.getBoundingClientRect().width;
      const anim = img.animate(
        [
          { margin: "0 0.0625cm", width: `${width}px` },
          { margin: "0 0", width: "0" },
        ],
        {
          duration: this.options.popDownDuration,
          fill: "forwards",
          easing: this.options.easing,
        }
      );
      await anim.finished;

      // Cleanup blob URL to prevent memory leaks
      if (img.dataset.blobUrl) {
        URL.revokeObjectURL(img.dataset.blobUrl);
      }
      img.remove();
    });

    await Promise.all(promises);
  }

  private resetStyle(image: HTMLImageElement) {
    image.style.removeProperty("box-shadow");
    image.style.removeProperty("margin");
    image.style.removeProperty("transform");
    image.style.removeProperty("transform-origin");
    image.style.removeProperty("width");
    image.style.removeProperty("z-index");
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
