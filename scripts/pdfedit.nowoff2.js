// fontkit reaches for brotli to decompress WOFF2. Nothing here ever hands it one: the fonts this
// editor reads come out of PDF files as TrueType or CFF, and the fonts it embeds are read off the
// local font library or shipped by us in the same form. So the decompressor is replaced by a
// sentence explaining why it is not there -- which is a better thing to find in a stack trace
// than a hundred kilobytes of unreachable code.
//
// fontkit 会去找 brotli 来解 WOFF2。这里从没有人会递给它一份:本编辑器读的字体从 PDF 里出来,
// 是 TrueType 或 CFF;它嵌入的字体来自本机字体库或由我们随包发出,同样是这两种形态。
// 于是解压器被换成一句"它为什么不在这里" —— 比起一百多 KB 永远走不到的代码,
// 这是在调用栈里更值得看到的东西。

export default function decompressWOFF2() {
  throw new Error('WOFF2 is not supported here: hand this a TrueType or CFF font instead');
}
