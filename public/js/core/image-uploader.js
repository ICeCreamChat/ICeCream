/**
 * ICeCream - Image Uploader Module (with Cropping)
 * Handles image selection, cropping, and uploading
 */

import { messageHandler } from './message-handler.js';

/**
 * Image Uploader Class
 */
class ImageUploader {
    constructor() {
        this.elements = {
            uploadBtn: null,
            fileInput: null,
            previewModal: null,
            previewImage: null,
            previewConfirm: null,
            previewCancel: null,
            previewCancelBtn: null
        };
        this.cropper = null;
    }

    /**
     * Initialize the uploader
     */
    init() {
        this.elements.uploadBtn = document.getElementById('upload-btn');
        this.elements.fileInput = document.getElementById('file-input');
        // Use the existing modal ID from index.html (image-preview-modal)
        this.elements.previewModal = document.getElementById('image-preview-modal');
        this.elements.previewImage = document.getElementById('preview-image');
        this.elements.previewConfirm = document.getElementById('preview-confirm');
        this.elements.previewCancel = document.getElementById('preview-cancel');
        this.elements.previewCancelBtn = document.getElementById('preview-cancel-btn');

        this._bindEvents();
    }

    /**
     * Bind events
     * @private
     */
    _bindEvents() {
        // Trigger file input
        this.elements.uploadBtn?.addEventListener('click', () => {
            this.elements.fileInput?.click();
        });

        // File selection
        this.elements.fileInput?.addEventListener('change', (e) => {
            this.handleFileSelect(e);
        });

        // Confirm (Send)
        this.elements.previewConfirm?.addEventListener('click', () => {
            this.sendWithCroppedImage();
        });

        // Cancel (X button)
        this.elements.previewCancel?.addEventListener('click', () => {
            this.hidePreview();
            messageHandler.setPendingImage(null);
        });

        // Cancel (Button)
        this.elements.previewCancelBtn?.addEventListener('click', () => {
            this.hidePreview();
            messageHandler.setPendingImage(null);
        });
    }

    /**
     * Handle file selection
     * @param {Event} e 
     */
    handleFileSelect(e) {
        const file = e.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const imageBase64 = event.target.result;
            // Don't set pending image yet, wait for crop
            this.showPreview(imageBase64);
        };
        reader.readAsDataURL(file);

        // Reset input
        e.target.value = '';
    }

    /**
     * Show preview with Cropper
     * @param {string} imageBase64 
     */
    showPreview(imageBase64) {
        if (this.elements.previewImage && this.elements.previewModal) {
            this.elements.previewImage.src = imageBase64;
            this.elements.previewModal.classList.remove('hidden');

            // Initialize Cropper
            if (this.cropper) {
                this.cropper.destroy();
            }

            // Wait for image to load slightly/ensure DOM is ready
            setTimeout(() => {
                this.cropper = new Cropper(this.elements.previewImage, {
                    viewMode: 1,
                    dragMode: 'move',
                    autoCropArea: 1,  // Default to selecting entire image
                    restore: false,
                    guides: true,
                    center: true,
                    highlight: false,
                    cropBoxMovable: true,
                    cropBoxResizable: true,
                    toggleDragModeOnDblclick: false,
                });
            }, 100);
        }
    }

    /**
     * Hide preview and destroy cropper
     */
    hidePreview() {
        if (this.elements.previewModal) {
            this.elements.previewModal.classList.add('hidden');
        }
        if (this.cropper) {
            this.cropper.destroy();
            this.cropper = null;
        }
    }

    /**
     * Get cropped image and send
     */
    sendWithCroppedImage() {
        if (!this.cropper) {
            // Fallback to direct send if cropper failed
            this.sendWithOriginalImage();
            return;
        }

        const canvas = this.cropper.getCroppedCanvas({
            maxWidth: 2048,
            maxHeight: 2048,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high',
        });

        const croppedBase64 = canvas.toDataURL('image/jpeg', 0.9);

        // Update handler with the CROPPED image
        messageHandler.setPendingImage(croppedBase64);

        this.hidePreview();
        this.sendInternal();
    }

    sendWithOriginalImage() {
        // Fallback or original logic
        this.sendInternal();
    }

    sendInternal() {
        const chatInput = document.getElementById('chat-input');
        const message = chatInput?.value.trim() || '请帮我解答这道题';

        if (chatInput) {
            chatInput.value = message;
        }

        messageHandler.handleSend();
    }
}

// Export singleton
export const imageUploader = new ImageUploader();
