/**
 * 组件测试的全局 setup（P2「前端组件测试底座」）。
 *
 * jsdom 实现了 `<dialog>` 元素与 `open` 属性，但**没有** `showModal` / `close`
 * （那是浏览器行为）。`ModalDialog.vue` 走原生 dialog，所以这里补最小实现：
 * 打开 / 关闭只切 `open` 属性，够组件测试断言「弹窗有没有出现」。
 */
const dialogPrototype =
  typeof HTMLDialogElement === "undefined"
    ? undefined
    : (HTMLDialogElement.prototype as HTMLDialogElement & {
        showModal?: () => void;
        close?: () => void;
      });

if (dialogPrototype) {
  if (typeof dialogPrototype.showModal !== "function") {
    dialogPrototype.showModal = function showModal(this: HTMLDialogElement): void {
      this.setAttribute("open", "");
    };
  }
  if (typeof dialogPrototype.close !== "function") {
    dialogPrototype.close = function close(this: HTMLDialogElement): void {
      this.removeAttribute("open");
    };
  }
}
