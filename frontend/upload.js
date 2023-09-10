const selectButton = document.getElementById("select");
const uploadButton = document.getElementById("upload");

if (!window.location.hash) {
  const newHash = prompt("Please enter the event's secret");
  if (newHash !== null) {
    window.location.hash = `#${newHash}`;
  }
}
if (window.location.hash) {
  selectButton.disabled = false;
}

let objectUrl = null;
const selectedImage = document.getElementById("selected");
selectedImage.onload = () => {
  URL.revokeObjectURL(objectUrl);
  uploadButton.disabled = false;
};

const filePicker = document.createElement("input");
filePicker.type = "file";
filePicker.accept = "image/*";
filePicker.addEventListener("change", () => {
  selectedImage.src = URL.createObjectURL(filePicker.files[0]);
});

selectButton.addEventListener("click", () => {
  filePicker.click();
});

uploadButton.addEventListener("click", async () => {
  const form = new FormData();
  form.append("image", filePicker.files[0]);
  await fetch(
    new URL(`./upload/${window.location.hash.substring(1)}`, window.location),
    {
      method: "POST",
      body: form,
    }
  );
  selectedImage.removeAttribute("src");
  uploadButton.disabled = true;
});
