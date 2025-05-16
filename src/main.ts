import {
  Notice,
  Plugin,
  Editor,
  MarkdownView,
  EditorPosition,
  normalizePath,
  TFile,
} from "obsidian";

import axios from "axios";
import objectPath from 'object-path';
import ImageUploaderSettingTab from './settings-tab';
import Compressor from 'compressorjs';

import {
  PasteEventCopy,
} from './custom-events';
import { resolve } from "path";
import { get } from "http";

// Avoid the error: Property 'clipboardManager' does not exist on type 'MarkdownSubView'
declare module 'obsidian' {
  interface MarkdownSubView {
    clipboardManager: ClipboardManager
  }
}

interface ClipboardManager {
  handlePaste(e: ClipboardEvent): void
  handleDrop(e: DragEvent): void
}

interface ImageUploaderSettings {
  apiEndpoint: string;
  uploadHeader: string;
  uploadBody: string;
  imageUrlPath: string;
  maxWidth: number;
  enableResize: boolean;
  maxConcurrentUploads: number;
}

const DEFAULT_SETTINGS: ImageUploaderSettings = {
  apiEndpoint: "",
  uploadHeader: "",
  uploadBody: "{\"image\": \"$FILE\"}",
  imageUrlPath: "",
  maxWidth: 4096,
  enableResize: false,
  maxConcurrentUploads: 3,
};

interface pasteFunction {
  (this: HTMLElement, event: ClipboardEvent): void;
}

export default class ImageUploader extends Plugin {
  settings: ImageUploaderSettings;
  pasteFunction: pasteFunction;

  private async replaceText(target: string, replacement: string, editor?: Editor, file?: TFile): Promise<void> {
    target = target.trim();
    if (editor) {
      const lines = editor.getValue().split("\n");
      for (let i = 0; i < lines.length; i++) {
        const ch = lines[i].indexOf(target);
        if (ch !== -1) {
          const from = { line: i, ch: ch } as EditorPosition;
          const to = { line: i, ch: ch + target.length } as EditorPosition;
          editor.setCursor(from);
          editor.replaceRange(replacement, from, to);
          break;
        }
      }
    } else if (file) {
      let content = await this.app.vault.read(file);
      if (content.includes(target)) {
        content = content.replace(target, replacement);
        await this.app.vault.modify(file, content);
      }
    }
  }

  async pasteHandler(ev: ClipboardEvent, editor: Editor, mkView: MarkdownView): Promise<void> {
    if (ev.defaultPrevented) {
      console.log("paste event is canceled");
      return;
    }

    const clipboardData = ev.clipboardData?.files[0];
    const imageType = /image.*/;
    if (clipboardData && clipboardData.type.match(imageType)) {
      let file: File = clipboardData!;
      ev.preventDefault();

      // set the placeholder text
      const randomString = (Math.random() * 10086).toString(36).substring(0, 8);
      const pastePlaceText = `![uploading...](${randomString})\n`
      editor.replaceSelection(pastePlaceText)

      // resize the image
      if (this.settings.enableResize) {
        const maxWidth = this.settings.maxWidth
        const compressedFile = await new Promise((resolve, reject) => {
          new Compressor(file, {
            maxWidth: maxWidth,
            success: resolve,
            error: reject,
          })
        })
        file = compressedFile as File
      }
      console.log(" clipboardData", clipboardData);
      this.uploadImage(file).then(async url => {
        const imgMarkdownText = `![](${url})`
        // this.replaceText(editor, pastePlaceText, imgMarkdownText)
        await this.replaceText(pastePlaceText, imgMarkdownText, editor);
      
      }, async err => {
        new Notice('[Image Uploader] Upload unsuccessfully, fall back to default paste!', 5000)
        console.log(err)
        // this.replaceText(editor, pastePlaceText, "");
        await this.replaceText(pastePlaceText, file.name, editor);
      
        mkView.currentMode.clipboardManager.handlePaste(
          new PasteEventCopy(ev)
        );
      })
    }
  }

  private uploadQueue: (() => Promise<void>)[] = [];
  private activeUploads = 0;

  // 控制上传队列并发
  private enqueueUpload(task: () => Promise<void>) {
    this.uploadQueue.push(task);
    this.processQueue();
  }

  private processQueue() {
    const count = this.settings.maxConcurrentUploads ? this.settings.maxConcurrentUploads : 3;
    while (this.activeUploads < count && this.uploadQueue.length > 0) {
      const task = this.uploadQueue.shift()!;
      this.activeUploads++;
      task().finally(() => {
        this.activeUploads--;
        this.processQueue();
      });
    }
  }

  async uploadImage(image: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const formData = new FormData();
      const uploadBody = JSON.parse(this.settings.uploadBody);

      for (const key in uploadBody) {
        if (uploadBody[key] === "$FILE") {
          formData.append(key, image, image.name);
        } else {
          formData.append(key, uploadBody[key]);
        }
      }

      axios.post(this.settings.apiEndpoint, formData, {
        headers: JSON.parse(this.settings.uploadHeader),
      }).then(res => {
        const url = objectPath.get(res.data, this.settings.imageUrlPath);
        resolve(url);
      }).catch(reject);
    });
  }

  async uploadLocalImages(): Promise<void> {
    console.log("uploading local images");
    // 获取全部的文件
    const allFiles = this.app.vault.getFiles();
    allFiles.forEach(file => {
      // 判断文件是否是md 文件
      if (file.extension !== "md") return;
      const allFiles = this.app.vault.getFiles();

      // 获取file 的内容
      this.app.vault.read(file).then(async (data) => {
        const lines = data.split("\n");
        await this.getPageImages(lines, allFiles,undefined,file);
      });
    });


  }

  async uploadActivatePageLocalImages(): Promise<void> {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!markdownView) return;

    const editor = markdownView.editor;
    const lines = editor.getValue().split("\n");

    const allFiles = this.app.vault.getFiles();
    try {
      await this.getPageImages(lines, allFiles, editor);
    } catch (err) {
      new Notice("[Image Uploader] Upload failed", 5000);
      console.error(err);
    }
    new Notice("[Image Uploader] Upload completed", 4000);
  }

 
  // 获取页面中的所有图片
  // lines: string[]
  async getPageImages(lines:string[],allFiles:TFile[],  editor?: Editor, mdfile?: TFile): Promise<void> {

    const imageNameAndLinks: { [key: string]: string }[] = [];
    const imageNames: string[] = [];

    for (const line of lines) {
      // 匹配本地图片链接或Markdown图片语法
      // (!\[\[.+\]\]) 匹配如 ![[image.png]]
      // (!\[.+\(.+\)) 匹配如 ![alt](image.png)
      const imageLinks = line.match(/(!\[\[.+\]\])|(!\[.+\(.+\))/gm);
      // const imageLinks = line.match(/(!\[\[.+$$\])|(!$$.+$$$.+$)/gm);
      if (!imageLinks) continue;

      for (const imageLink of imageLinks) {
        const imageInfo = imageLink.match(/(?:\[\[|!\[]\()(?<uri>.*?)(?:\)|\]\])/);
        if (!imageInfo) continue;

        const imageURI = imageInfo?.groups?.uri!;
        if (imageURI.startsWith("http")) continue;

        const imageName = decodeURIComponent(imageURI.split("/").pop()!);
        imageNameAndLinks.push({ [imageName]: imageLink });
        imageNames.push(imageName);
      }
    }

    const targetImages = allFiles.filter(file => imageNames.includes(file.name));

    let totalUploads = targetImages.length;
    let completedUploads = 0;

    if (totalUploads === 0) {
      if (editor) {
        new Notice("[Image Uploader] No local images found to upload.", 4000);
      }
      return;
    }

    for (const targetImage of targetImages) {
      this.enqueueUpload(async () => {
      const data = await this.app.vault.adapter.readBinary(normalizePath(targetImage.path));
      const blob = new Blob([data]);
      const file = new File([blob], targetImage.name, { type: "image/png" });

      try {
        const url = await this.uploadImage(file);
        const imgMarkdownText = `![](${url})`;
        const imageNameAndLink = imageNameAndLinks.find(item => Object.keys(item)[0] === targetImage.name);
        if (imageNameAndLink) {
        const imageLink = imageNameAndLink[targetImage.name];
          await this.replaceText(imageLink, imgMarkdownText, editor, mdfile);
        }
      } catch (err) {
        new Notice("[Image Uploader] Upload failed", 5000);
        console.error(err);
      } finally {
        completedUploads++;
        if (completedUploads === totalUploads) {
          const title = mdfile ? mdfile.name : "";
          new Notice(`[Image Uploader] ${title ? `Images in "${title}" uploaded` : "Images in current file uploaded"}`, 4000);
        }
      }
      });
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    // this.setupPasteHandler()
    this.addSettingTab(new ImageUploaderSettingTab(this.app, this));

    this.pasteFunction = this.pasteHandler.bind(this);

    this.registerEvent(
      this.app.workspace.on('editor-paste', this.pasteFunction)
    );

    this.addCommand({
      id: 'upload-all-page-local-images',
      name: 'Upload All Local Images in This Page',
      callback: this.uploadActivatePageLocalImages.bind(this),
    });
    this.addCommand({
      id: 'upload-all-local-images',
      name: 'Upload All Local Images in Obsidian',
      callback: this.uploadLocalImages.bind(this),
    });
  }

  onunload(): void {
    this.app.workspace.off('editor-paste', this.pasteFunction);
    console.log("unloading Image Uploader");
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
