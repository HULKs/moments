const selectButtons = [
  "button-select-first",
  "select-button-ready-to-upload",
  "button-select-another",
  "button-select-another-after-error",
].map((id) => document.getElementById(id));
const uploadButton = document.getElementById("upload-button-ready-to-upload");

if (!window.location.hash) {
  const newHash = prompt("Please enter the event's secret");
  if (newHash !== null) {
    window.location.hash = `#${newHash}`;
  }
}
if (window.location.hash) {
  (async () => {
    const secret = window.location.hash.substring(1).toLowerCase();
    const response = await fetch(
      new URL(`./${secret}/upload`, window.location),
      {
        method: "OPTIONS",
      }
    );
    console.log(response);
    if (response.status != 405) {
      alert("Failed to check for correct secret (!= 405)");
      window.location.hash = "";
      return;
    }
    const correctSecret = response.headers.get("allow") === "POST";
    if (!correctSecret) {
      alert(`Incorrect event secret "${secret}"`);
      window.location.hash = "";
      return;
    }
    document.body.className = "state-select-first";
  })();
}

const selectedImagesContainer = document.getElementById("selected-images");
let selectedFiles = [];

const filePicker = document.createElement("input");
filePicker.multiple = true;
filePicker.type = "file";
filePicker.accept = "image/bmp,image/jpeg,image/png,image/tiff,image/webp";
let previewedFiles = [];

filePicker.addEventListener("change", () => {
  selectedFiles = Array.from(filePicker.files);
  selectedImagesContainer.innerHTML = "";

  if (selectedFiles.length === 0) {
    document.body.className = "state-select-first";
    return;
  }

  loadImages(selectedFiles);
});

async function loadImages(files) {
  previewedFiles = [];

  const loadImage = (file) => {
    return new Promise((resolve, reject) => {
      const img = document.createElement("img");
      const objectUrl = URL.createObjectURL(file);
      img.src = objectUrl;

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ img, file });
      };

      img.onerror = (error) => {
        URL.revokeObjectURL(objectUrl);
        reject({ error, file });
      };
    });
  };

  const loadPromises = files.map((file) => loadImage(file).catch((e) => e));

  const results = await Promise.all(loadPromises);

  const successfulResults = results.filter((r) => !r.error);
  const failedResults = results.filter((r) => r.error);

  const count = successfulResults.length;
  let maxWidth = "100%";
  if (count > 0) {
    maxWidth = `${Math.floor(100 / Math.min(count, 5))}%`;
  }

  selectedImagesContainer.innerHTML = "";

  successfulResults.forEach(({ img, file }) => {
    img.style.setProperty("max-width", maxWidth);
    selectedImagesContainer.appendChild(img);
    previewedFiles.push(file);
  });

  if (failedResults.length > 0) {
    failedResults.forEach(({ file }) => {
      console.warn(`Failed to load image preview for: ${file.name}`);
    });
    alert(`${failedResults.length} image(s) failed to load and won't be uploaded.`);
  }

  document.body.className = successfulResults.length > 0 ? "state-ready-to-upload" : "state-select-first";
}


selectButtons.forEach((selectButton) =>
  selectButton.addEventListener("click", () => {
    filePicker.click();
  })
);

uploadButton.addEventListener("click", async () => {
  if (previewedFiles.length === 0) {
    alert("No valid images to upload.");
    return;
  }

  document.body.className = "state-progress";
  const secret = window.location.hash.substring(1).toLowerCase();
  const uploadUrl = new URL(`./${secret}/upload`, window.location);

  const uploadPromises = previewedFiles.map(async (file) => {
    const form = new FormData();
    form.append("image", file);
    try {
      const response = await fetch(uploadUrl, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        throw await response.text();
      }
      return { file, success: true };
    } catch (error) {
      return { file, success: false, error };
    }
  });

  const results = await Promise.allSettled(uploadPromises);

  selectedImagesContainer.innerHTML = "";

  const ul = document.createElement("ul");

  results.forEach((result) => {
    const li = document.createElement("li");
    if (result.status === "fulfilled") {
      const { file, success, error } = result.value;
      li.textContent = success
        ? `✅ Uploaded: ${file.name}`
        : `❌ Failed: ${file.name} - ${error}`;
    } else {
      li.textContent = `❌ Unexpected error during upload.`;
    }
    ul.appendChild(li);
  });

  selectedImagesContainer.appendChild(ul);

  const hasErrors = results.some(
    (result) => result.status !== "fulfilled" || !result.value.success
  );

  document.body.className = hasErrors
    ? "state-select-another-after-error"
    : "state-select-another";

  previewedFiles = [];
  selectedFiles = [];
  filePicker.value = "";
});
