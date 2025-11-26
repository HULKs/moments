import {
  defaults,
  getAlbumInfo,
  viewAsset,
  AssetMediaSize
} from '@immich/sdk';
import type { KioskConfig, KioskAsset } from './types';

export class ImmichService {
  private seenIds = new Set<string>();
  private newQueue: KioskAsset[] = [];
  private oldQueue: KioskAsset[] = [];
  private config: KioskConfig;

  constructor(config: KioskConfig) {
    this.config = config;
    // In src/immichService.ts constructor

    // If user enters empty string or "/", handle it gracefully
    let cleanBaseUrl = config.baseUrl || "";

    if (cleanBaseUrl === "" || cleanBaseUrl === "/") {
      // If using proxy, we just want to point to the /api path relative to current domain
      cleanBaseUrl = "/api";
    } else {
      // Normal absolute URL cleaning
      if (cleanBaseUrl.endsWith('/')) cleanBaseUrl = cleanBaseUrl.slice(0, -1);
      if (!cleanBaseUrl.endsWith('/api')) cleanBaseUrl += '/api';
    }

    defaults.baseUrl = cleanBaseUrl;
    defaults.headers = {
      "x-api-key": config.apiKey,
      "Accept": "application/json",
    };
  }

  /**
   * Starts polling the album for new content.
   */
  public async startPolling(intervalMs: number = 5000) {
    await this.refreshAssets();
    setInterval(() => {
      this.refreshAssets().catch(console.error);
    }, intervalMs);
  }

  private async refreshAssets() {
    try {
      const albumInfo = await getAlbumInfo({ id: this.config.albumId });

      // Sort by creation date to identify "new" items correctly
      const assets = albumInfo.assets.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      for (const asset of assets) {
        if (!this.seenIds.has(asset.id)) {

          // Extract dimensions from EXIF, default to 1920x1080 if missing (e.g. unprocessed videos)
          const width = asset.exifInfo?.exifImageWidth || 1920;
          const height = asset.exifInfo?.exifImageHeight || 1080;

          const kioskAsset: KioskAsset = {
            id: asset.id,
            width,
            height,
            createdAt: new Date(asset.createdAt)
          };

          this.newQueue.push(kioskAsset);
          this.seenIds.add(asset.id);

          // Add to oldQueue immediately so it enters the rotation after being shown once
          this.oldQueue.push(kioskAsset);
        }
      }
    } catch (err) {
      console.error("Error polling Immich album:", err);
    }
  }

  /**
   * Downloads the image blob using the `viewAsset` endpoint.
   */
  public async fetchImageBlob(asset: KioskAsset): Promise<string> {
    try {
      // Use 'viewAsset' as per the definition file provided.
      // We request 'Preview' size for better performance than 'Fullsize' but better quality than 'Thumbnail'.
      const blob = await viewAsset({
        id: asset.id,
        size: AssetMediaSize.Preview
      });

      return URL.createObjectURL(blob);
    } catch (error) {
      console.error(`Failed to load image for ${asset.id}`, error);
      throw error;
    }
  }

  public async getNextImage(): Promise<KioskAsset | undefined> {
    // 1. Priority: New assets
    if (this.newQueue.length > 0) {
      return this.newQueue.pop();
    }

    // 2. Fallback: Random old asset
    if (this.oldQueue.length > 0) {
      const randomIndex = Math.floor(Math.random() * this.oldQueue.length);
      return this.oldQueue[randomIndex];
    }

    return undefined;
  }

  public hasContent(): boolean {
    return this.seenIds.size > 0;
  }
}
