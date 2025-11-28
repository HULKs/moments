export interface KioskAsset {
  id: string;
  // We need dimensions for the 'pop' animation logic
  width: number;
  height: number;
  // Creation time for sorting/prioritization
  createdAt: Date;
  // Distinguish between Image and Video
  type: 'IMAGE' | 'VIDEO';
}

export interface KioskConfig {
  baseUrl: string;
  apiKey: string;
  albumId: string;
}
