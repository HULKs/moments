import { DefaultOptions, KioskEngine } from "./kioskEngine";
import { ImmichService } from "./immichService";

const KEY_BASE_URL = "immich_base_url";
const KEY_API_KEY = "immich_api_key";
const KEY_ALBUM_ID = "immich_album_id";

const setupDiv = document.getElementById("setup") as HTMLDivElement;
const urlInput = document.getElementById("baseUrl") as HTMLInputElement;
const keyInput = document.getElementById("apiKey") as HTMLInputElement;
const albumInput = document.getElementById("albumId") as HTMLInputElement;
const startBtn = document.getElementById("startBtn") as HTMLButtonElement;

// Restore previous values
urlInput.value = localStorage.getItem(KEY_BASE_URL) || "";
keyInput.value = localStorage.getItem(KEY_API_KEY) || "";
albumInput.value = localStorage.getItem(KEY_ALBUM_ID) || "";

startBtn.addEventListener("click", async () => {
  const baseUrl = urlInput.value.trim();
  const apiKey = keyInput.value.trim();
  const albumId = albumInput.value.trim();

  if (!baseUrl || !apiKey || !albumId) {
    alert("Please fill in all fields");
    return;
  }

  // Save configs
  localStorage.setItem(KEY_BASE_URL, baseUrl);
  localStorage.setItem(KEY_API_KEY, apiKey);
  localStorage.setItem(KEY_ALBUM_ID, albumId);

  setupDiv.classList.add("hidden");

  try {
    const service = new ImmichService({ baseUrl, apiKey, albumId });

    // Start polling in background
    await service.startPolling(5000);

    const engine = new KioskEngine(service, DefaultOptions);
    engine.start();
  } catch (error) {
    console.error(error);
    alert("Failed to start kiosk. Check console for details.");
    setupDiv.classList.remove("hidden");
  }
});
