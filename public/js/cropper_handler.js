/**
 * ICeCream - CropperHandler Module (Ported from MathSolver)
 * Copyright (c) 2026 ICeCreamChat
 * Licensed under the MIT License.
 *
 * Handles image selection and cropping.
 */
const CropperHandler = {
    /**
     * Handles file selection from input.
     */
    handleFileSelect(e) {
        const file = e.target.files[0];
        if (file && file.type.startsWith('image/')) {
            StateManager.set('originalImageFile', file);
            this.openCropModal(file);
        }
        e.target.value = '';
    },

    /**
     * Opens the crop modal with the given file.
     */
    openCropModal(file) {
        const cropModal = document.getElementById('crop-modal');
        const cropImage = document.getElementById('crop-image');

        const reader = new FileReader();
        reader.onload = (e) => {
            cropImage.src = e.target.result;
            cropModal.classList.add('active');

            let cropper = StateManager.get('cropper');
            if (cropper) {
                cropper.destroy();
            }

            cropper = new Cropper(cropImage, {
                aspectRatio: NaN,
                viewMode: 1,
                autoCropArea: 1,
                responsive: true,
                background: false
            });
            StateManager.set('cropper', cropper);
        };
        reader.readAsDataURL(file);
    },

    /**
     * Closes the crop modal.
     */
    closeCropModal() {
        const cropModal = document.getElementById('crop-modal');
        cropModal.classList.remove('active');

        const cropper = StateManager.get('cropper');
        if (cropper) {
            cropper.destroy();
            StateManager.set('cropper', null);
        }
    },

    /**
     * Resets the crop selection.
     */
    resetCrop() {
        const cropper = StateManager.get('cropper');
        if (cropper) {
            cropper.reset();
        }
    },

    /**
     * Confirms the crop and starts solving.
     */
    confirmCrop() {
        const cropper = StateManager.get('cropper');
        if (!cropper) return;

        const { MAX_CROP_DIMENSION, CROP_QUALITY } = window.CONSTANTS || { MAX_CROP_DIMENSION: 2048, CROP_QUALITY: 0.92 };

        const canvas = cropper.getCroppedCanvas({
            maxWidth: MAX_CROP_DIMENSION,
            maxHeight: MAX_CROP_DIMENSION
        });

        const croppedImageData = canvas.toDataURL('image/jpeg', CROP_QUALITY);
        StateManager.set('croppedImageData', croppedImageData);

        this.closeCropModal();

        // Display user message with image
        if (window.displayMessage) {
            window.displayMessage('user', null, croppedImageData, true);
        }

        // Start solving
        if (window.startSolving) {
            window.startSolving();
        }
    }
};

window.CropperHandler = CropperHandler;
