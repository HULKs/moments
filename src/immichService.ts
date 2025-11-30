import {
  defaults,
  getAlbumInfo,
  viewAsset,
  playAssetVideo,
  AssetMediaSize,
  AssetTypeEnum
} from '@immich/sdk';
import type { KioskConfig, KioskAsset } from './types';

export class ImmichService {
  private fetchedIds = new Set<string>();
  private newQueue: KioskAsset[] = [];
  private availableAssets: Set<KioskAsset> = new Set();
  private config: KioskConfig;
  private isConnected: boolean = true;

  constructor(config: KioskConfig) {
    this.config = config;

    let cleanBaseUrl = config.baseUrl || "";
    if (cleanBaseUrl === "" || cleanBaseUrl === "/") {
      cleanBaseUrl = "/api";
    } else {
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
      this.refreshAssets(true).catch(console.error);
    }, intervalMs);
  }

  /**
   * Returns the current connection status to the Immich server.
   */
  public isImmichConnected(): boolean {
    return this.isConnected;
  }

  private async refreshAssets(pushToNew: boolean = false) {
    try {
      const albumInfo = await getAlbumInfo({ id: this.config.albumId });

      // Update status on success
      this.isConnected = true;

      const assets = albumInfo.assets.sort((a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      for (const asset of assets) {
        if (!this.fetchedIds.has(asset.id)) {

          // Extract dimensions from EXIF, default to 1920x1080 if missing
          const width = asset.exifInfo?.exifImageWidth || 1920;
          const height = asset.exifInfo?.exifImageHeight || 1080;

          // Determine type based on SDK enum
          const type = asset.type === AssetTypeEnum.Video ? 'VIDEO' : 'IMAGE';

          const kioskAsset: KioskAsset = {
            id: asset.id,
            width,
            height,
            createdAt: new Date(asset.createdAt),
            type
          };

          this.fetchedIds.add(asset.id);

          if (pushToNew) {
            this.newQueue.push(kioskAsset);
          }
          this.availableAssets.add(kioskAsset);
        }
      }
    } catch (err) {
      console.error("Error polling Immich album:", err);
      // Update status on failure
      this.isConnected = false;
    }
  }

  /**
   * Downloads the image blob using the `viewAsset` endpoint.
   */
  public async fetchImageBlob(asset: KioskAsset): Promise<string> {
    try {
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

  /**
    * Downloads the video blob using the `playAssetVideo` endpoint.
    */
  public async fetchVideoBlob(asset: KioskAsset): Promise<string> {
    try {
      const blob = await playAssetVideo({
        id: asset.id,
      });

      return URL.createObjectURL(blob);
    } catch (error) {
      console.error(`Failed to load video for ${asset.id}`, error);
      throw error;
    }
  }

  public async getNextImage(displayedIds: Set<string>): Promise<KioskAsset | undefined> {
    // 1. Priority: New assets
    if (this.newQueue.length > 0) {
      return this.newQueue.pop();
    }

    // 2. Fallback: Random old asset that is not yet shown
    const notShownIds = this.availableAssets.difference(displayedIds)
    if (notShownIds.size > 0) {
      return [...notShownIds][Math.floor(Math.random() * notShownIds.size)];
    }

    // 3. Fallback: Random old asset
    if (this.availableAssets.size > 0) {
      return [...this.availableAssets][Math.floor(Math.random() * this.availableAssets.size)];
    }

    return undefined;
  }

  public hasContent(): boolean {
    return this.fetchedIds.size > 0;
  }
}
