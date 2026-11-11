import { ImmichService } from "./immichService";
import type { KioskAsset } from "./types";

interface KioskOptions {
  highlightScale: number;
  popUpDuration: number;
  highlightDuration: number;
  popDownDuration: number;
  allowedRelativeWidthFromCenterForAdditions: number;
  easing: string;
  rowHeight: number;
}

const baseDuration = 1250;

export const DefaultOptions: KioskOptions = {
  highlightScale: 1.5,
  popUpDuration: baseDuration,
  highlightDuration: baseDuration * 5,
  popDownDuration: baseDuration * 0.75,
  allowedRelativeWidthFromCenterForAdditions: 0.4,
  easing: "cubic-bezier(0.65, 0.05, 0.36, 1)",
  rowHeight: 200,
};

// Helper type for our grid items
type KioskMediaElement = HTMLImageElement | HTMLVideoElement;

export class KioskEngine {
  private options: KioskOptions;
  private service: ImmichService;
  private isRunning = false;
  private rowElements: HTMLDivElement[] = [];
  private displayedIds = new Set<string>();
  private needsLayoutUpdate = false;
  private readonly handleResize = () => {
    this.needsLayoutUpdate = true;
  };

  constructor(service: ImmichService, options: KioskOptions = DefaultOptions) {
    this.service = service;
    this.options = options;
  }

  public async start() {
    this.isRunning = true;

    // Hide cursor when the show starts
    document.body.classList.add('no-cursor');

    this.setupGrid();
    window.addEventListener('resize', this.handleResize);

    // Wait for at least one asset to exist
    while (this.isRunning && !this.service.hasContent()) {
      await this.sleep(500);
    }

    // Initial Fill: Fill the screen with historical assets
    await this.fillScreen();

    // Main Loop: Add new assets one by one with animation
    while (this.isRunning) {
      try {
        if (this.needsLayoutUpdate) {
          this.updateGrid();
          await this.fillScreen();
        }
        await this.processNextIteration();
      } catch (error) {
        console.error("Error in main loop:", error);
        await this.sleep(1000);
      }
    }
  }

  public stop() {
    this.isRunning = false;
    window.removeEventListener('resize', this.handleResize);
    // Show cursor again if stopped
    document.body.classList.remove('no-cursor');
  }

  private setupGrid() {
    document.body.innerHTML = '';
    this.rowElements = [];
    document.body.style.setProperty('--row-height', `${this.options.rowHeight}px`);
    this.updateGrid();
  }

  private updateGrid() {
    this.needsLayoutUpdate = false;
    const style = getComputedStyle(document.body);
    const gap = parseFloat(style.rowGap);
    const availableHeight = window.innerHeight - parseFloat(style.marginTop);
    const rowCount = Math.max(1, Math.ceil((availableHeight + gap) / (this.options.rowHeight + gap)));

    while (this.rowElements.length > rowCount) {
      const row = this.rowElements.pop()!;
      for (const element of row.querySelectorAll<KioskMediaElement>('img, video')) {
        this.removeAsset(element);
      }
      row.remove();
    }

    while (this.rowElements.length < rowCount) {
      const row = document.createElement("div");
      row.classList.add("row");
      document.body.appendChild(row);
      this.rowElements.push(row);
    }
  }

  private async fillScreen() {
    for (const selectedRow of this.rowElements) {
      // Try to fill row until width > viewport
      while (this.isRunning) {
        const mediaInRow = Array.from(selectedRow.querySelectorAll("img, video")) as KioskMediaElement[];
        const widthOfRow = mediaInRow.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0);

        if (widthOfRow >= window.innerWidth) break;

        try {
          // Append during filling; center-only insertion is for animated additions.
          const element = await this.loadAndInsertAsset(selectedRow, []);
          if (!element) break;
          // For initial fill, we don't want the "pop" animation state left over
          this.resetStyle(element);
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
    // Select both images and videos
    const mediaInRow = Array.from(selectedRow.querySelectorAll("img, video")) as KioskMediaElement[];

    const element = await this.loadAndInsertAsset(selectedRow, mediaInRow);
    if (!element) {
      // No asset loaded (maybe empty queue), wait a bit
      await this.sleep(500);
      return;
    }

    // Get dimensions regardless of element type
    const { width: naturalWidth, height: naturalHeight } = this.getMediaDimensions(element);

    // CSS pixels scale with browser zoom, just like the row height.
    const width = (selectedRow.getBoundingClientRect().height / naturalHeight) * naturalWidth;

    await this.animatePopUp(element, width);
    await this.sleep(this.options.highlightDuration);

    await Promise.all([
      this.animatePopDown(element, width),
      this.removeOutOfViewportAssets(selectedRow),
    ]);

    this.resetStyle(element);
  }

  private async loadAndInsertAsset(
    row: HTMLDivElement,
    siblingsInRow: KioskMediaElement[]
  ): Promise<KioskMediaElement | null> {

    let element: KioskMediaElement;

    // Insertion Logic
    if (siblingsInRow.length > 0) {
      const viewportWidth = window.innerWidth;
      const validSiblings = siblingsInRow.filter((el) => {
        const left = el.getBoundingClientRect().left;
        const rel = this.options.allowedRelativeWidthFromCenterForAdditions;
        return (
          left >= (0.5 - rel) * viewportWidth &&
          left <= (0.5 + rel) * viewportWidth
        );
      });

      if (validSiblings.length === 0) return null;

      const sibling = validSiblings[Math.floor(Math.random() * validSiblings.length)];

      const asset = this.service.getNextImage(this.displayedIds);
      if (!asset) return null;

      this.displayedIds.add(asset.id);

      // Create specific element based on type
      if (asset.type === 'VIDEO') {
        const vid = document.createElement("video");
        vid.muted = true;
        vid.autoplay = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.dataset.immichId = asset.id;
        element = vid;
      } else {
        element = document.createElement("img");
        element.dataset.immichId = asset.id;
      }

      row.insertBefore(element, sibling);

      // Initialize styles
      element.style.boxShadow = "none";
      element.style.margin = "0 0";
      element.style.transform = "none";
      element.style.width = "0";
      element.style.zIndex = "1";

      return this.loadAssetData(element, asset);

    } else {
      // Empty row case
      const asset = this.service.getNextImage(this.displayedIds);
      if (!asset) return null;

      this.displayedIds.add(asset.id);

      if (asset.type === 'VIDEO') {
        const vid = document.createElement("video");
        vid.muted = true;
        vid.autoplay = true;
        vid.loop = true;
        vid.playsInline = true;
        vid.dataset.immichId = asset.id;
        element = vid;
      } else {
        element = document.createElement("img");
        element.dataset.immichId = asset.id;
      }

      row.appendChild(element);

      // Initialize styles
      element.style.boxShadow = "none";
      element.style.margin = "0 0";
      element.style.transform = "none";
      element.style.width = "0";
      element.style.zIndex = "1";

      return this.loadAssetData(element, asset);
    }
  }

  private async loadAssetData(element: KioskMediaElement, asset: KioskAsset): Promise<KioskMediaElement | null> {
    try {
      let blobUrl: string;

      if (asset.type === 'VIDEO' && element instanceof HTMLVideoElement) {
        blobUrl = await this.service.fetchVideoBlob(asset);
        element.src = blobUrl;

        await new Promise<void>((resolve, reject) => {
          // For video, we wait for loadeddata so we have dimensions
          element.onloadeddata = () => resolve();
          element.onerror = (e) => reject(e);
        });
      } else {
        // Assume Image
        blobUrl = await this.service.fetchImageBlob(asset);
        element.src = blobUrl;

        await new Promise<void>((resolve, reject) => {
          element.onload = () => resolve();
          element.onerror = (e) => reject(e);
        });
      }

      // Tag element for cleanup later
      element.dataset.blobUrl = blobUrl;

      // Calculate Transform Origin
      const rect = element.getBoundingClientRect();
      const { width: naturalWidth, height: naturalHeight } = this.getMediaDimensions(element);

      const targetWidth = (rect.height / naturalHeight) * naturalWidth;
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

      element.style.transformOrigin = `${vOrigin} ${hOrigin}`;

      return element;

    } catch (e) {
      console.error("Failed to load asset data", e);
      element.remove();
      return null;
    }
  }

  private getMediaDimensions(element: KioskMediaElement): { width: number, height: number } {
    if (element instanceof HTMLVideoElement) {
      return { width: element.videoWidth, height: element.videoHeight };
    }
    return { width: element.naturalWidth, height: element.naturalHeight };
  }

  private async animatePopUp(element: KioskMediaElement, widthPx: number) {
    const animation = element.animate(
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
          width: `${widthPx}px`,
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

  private async animatePopDown(element: KioskMediaElement, widthPx: number) {
    const animation = element.animate(
      [
        {
          boxShadow: "0 0 1cm #000000",
          transform: `scale(${this.options.highlightScale})`,
          width: `${widthPx}px`,
        },
        {
          boxShadow: "0 0 1cm transparent",
          transform: "none",
          width: `${widthPx}px`,
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

  private async removeOutOfViewportAssets(row: HTMLDivElement) {
    // Select both images and videos
    const assets = Array.from(row.querySelectorAll("img, video")) as KioskMediaElement[];

    const outOfView = assets.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.right < 0 || rect.left > window.innerWidth;
    });

    const promises = outOfView.map(async (el) => {
      const width = el.getBoundingClientRect().width;
      const anim = el.animate(
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

      this.removeAsset(el);
    });

    await Promise.all(promises);
  }

  private removeAsset(element: KioskMediaElement) {
    for (const animation of element.getAnimations()) animation.cancel();
    if (element.dataset.blobUrl) URL.revokeObjectURL(element.dataset.blobUrl);
    if (element.dataset.immichId) this.displayedIds.delete(element.dataset.immichId);
    element.remove();
  }

  private resetStyle(element: KioskMediaElement) {
    element.style.removeProperty("box-shadow");
    element.style.removeProperty("margin");
    element.style.removeProperty("transform");
    element.style.removeProperty("transform-origin");
    element.style.removeProperty("width");
    element.style.removeProperty("z-index");
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
