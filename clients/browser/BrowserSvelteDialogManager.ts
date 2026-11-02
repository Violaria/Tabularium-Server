import {
    type ComponentHasResult,
    SvelteDialogManagerBase,
} from "@tabularium/sync-core/compat/services/implements/base/SvelteDialog";
import { createNativeElement } from "@clients/browserDom";
import type { ServiceContext } from "@tabularium/sync-core/context";
import type { SvelteDialogManagerDependencies } from "@tabularium/sync-core/compat/services/implements/base/SvelteDialog";
import { _activeDocument } from "@tabularium/sync-core/compat/common/coreEnvFunctions";
import DialogHost from "@/ui/dialogs/DialogHost.svelte";
import { SvelteDialogSession } from "@/ui/dialogs/SvelteDialogSession";

export class BrowserModal {
    contentEl: HTMLElement;
    titleEl: HTMLElement;
    modalEl: HTMLElement;
    isOpen: boolean = false;
    baseEl: HTMLElement;
    constructor() {
        const baseEl = createNativeElement(_activeDocument, "popup");
        this.baseEl = baseEl;
        this.contentEl = createNativeElement(_activeDocument, "div");
        this.contentEl.className = "modal-content";
        this.titleEl = createNativeElement(_activeDocument, "div");
        this.titleEl.className = "modal-title";
        this.modalEl = createNativeElement(_activeDocument, "div");
        this.modalEl.className = "modal";
        this.modalEl.hidden = true;
        this.modalEl.appendChild(this.titleEl);
        this.modalEl.appendChild(this.contentEl);
        this.baseEl.appendChild(this.modalEl);
    }
    open() {
        this.isOpen = true;
        this.modalEl.hidden = false;
        if (!this.baseEl.parentElement) {
            _activeDocument.body.appendChild(this.baseEl);
        }
        this.onOpen();
    }
    close() {
        this.isOpen = false;
        this.modalEl.hidden = true;
        this.baseEl.remove();
        this.onClose();
    }
    onOpen() {}
    onClose() {}
    setTitle(t: string) {
        this.titleEl.textContent = t;
    }
}

export class BrowserDialog<T, U, C extends ServiceContext = ServiceContext> extends BrowserModal {
    private readonly session: SvelteDialogSession<T, U, C>;

    constructor(
        context: C,
        dependents: SvelteDialogManagerDependencies<C>,
        component: ComponentHasResult<T, U>,
        initialData?: U
    ) {
        super();
        this.session = new SvelteDialogSession({
            surface: this,
            context,
            dependencies: dependents,
            dialogHost: DialogHost,
            component,
            initialData,
        });
    }

    override onOpen(): void {
        this.session.onOpen();
    }

    override onClose(): void {
        this.session.onClose();
    }

    waitForClose(): Promise<T | undefined> {
        return this.session.waitForClose();
    }
}
export class BrowserSvelteDialogManager<T extends ServiceContext> extends SvelteDialogManagerBase<T> {
    override async openSvelteDialog<TT, TU>(
        component: ComponentHasResult<TT, TU>,
        initialData?: TU
    ): Promise<TT | undefined> {
        const dialog = new BrowserDialog<TT, TU, T>(this.context, this.dependents, component, initialData);
        dialog.open();
        return await dialog.waitForClose();
    }
}
