declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdfParse(data: Buffer | Uint8Array, options?: any): Promise<{ text: string; numpages: number; info?: any; metadata?: any }>;
  export = pdfParse;
}
declare module 'pdf-parse' {
  function pdfParse(data: Buffer | Uint8Array, options?: any): Promise<{ text: string; numpages: number; info?: any; metadata?: any }>;
  export = pdfParse;
}
