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
  document.body.className = "state-select-first";
}

let objectUrl = null;
const selectedImage = document.getElementById("selected");
selectedImage.onload = () => {
  URL.revokeObjectURL(objectUrl);
  selectedImage.style.setProperty("display", "block");
  document.body.className = "state-ready-to-upload";
};
selectedImage.onerror = (error) => {
  selectedImage.style.setProperty("display", "none");
  selectedImage.removeAttribute("src");
  console.error(error);
  alert(`Failed to display image: ${error}`);
  document.body.className = "state-select-first";
};

const filePicker = document.createElement("input");
filePicker.type = "file";
filePicker.accept = "image/*";
filePicker.addEventListener("change", () => {
  selectedImage.src = URL.createObjectURL(filePicker.files[0]);
});

selectButtons.forEach((selectButton) =>
  selectButton.addEventListener("click", () => {
    filePicker.click();
  })
);

uploadButton.addEventListener("click", async () => {
  const form = new FormData();
  form.append("image", filePicker.files[0]);
  try {
    document.body.className = "state-progress";
    const response = await fetch(
      new URL(`./upload/${window.location.hash.substring(1)}`, window.location),
      {
        method: "POST",
        body: form,
      }
    );
    if (!response.ok) {
      throw await response.text();
    }
    document.body.className = "state-select-another";
  } catch (error) {
    document.body.className = "state-select-another-after-error";
    document.getElementById("error-reason").innerText = error;
  }
  selectedImage.style.setProperty("display", "none");
  selectedImage.removeAttribute("src");
});
