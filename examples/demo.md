# Caiyun Translation Demo

This document is written in English on purpose, so you can test the extension by translating it into Chinese.

## Why a preview button

Reading long English documentation in the editor works fine, but a quick Chinese preview helps when you only want to skim the content.

- Install the extension, then run **Caiyun: Show Translated Preview** from the command palette
- The current tab switches to a Chinese preview in place, without opening a new tab
- Run the toggle command again to switch back to the original English text

> This blockquote exists to check that quotes and their inner content survive translation intact.

### Code blocks stay untouched

```js
// Comments and strings must stay exactly as written
const greeting = 'Hello, world';
console.log(greeting);
```

Inline code behaves the same way: `npm run build` is never modified.

### Feature table

| Feature | Status | Notes |
|---|---|---|
| One-click translation | Done | Translates the whole document at once |
| Switch back to original | Done | Restores the English source |
| Live refresh | Done | Re-renders when the file changes |

### Mixed content

这个段落故意用中文写，用来验证「英文译中文」时不会反过来改动已有的中文内容。

### Links

- [VS Code official site](https://code.visualstudio.com)
- [Caiyun translator](https://www.caiyunapp.com)

---

Last paragraph: after translating, the status bar reports how many paragraphs were converted.
