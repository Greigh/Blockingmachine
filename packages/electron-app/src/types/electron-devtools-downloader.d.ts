declare module 'electron-devtools-installer/dist/downloadChromeExtension.js' {
  export function downloadChromeExtension(
    chromeStoreID: string,
    options?: { forceDownload?: boolean; attempts?: number },
  ): Promise<string>;
}
