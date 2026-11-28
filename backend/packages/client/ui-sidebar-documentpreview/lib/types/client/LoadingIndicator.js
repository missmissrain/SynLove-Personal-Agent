import { jsx as _jsx } from "react/jsx-runtime";
import clsx from 'clsx';
import { IconLoadingOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './LoadingIndicator.module.css';
/**
 * @param props - localized status label, carried as the accessible name with
 * no visible text, and optional placement style.
 * @returns an animated, accessible loading status.
 */
export function LoadingIndicator({ label, className }) {
    return _jsx("span", { className: clsx(css.loading, className), role: "status", "aria-label": label, "data-document-loading": true, children: _jsx("span", { className: css.icon, "aria-hidden": "true", children: _jsx(IconLoadingOutline16, {}) }) });
}
//# sourceMappingURL=LoadingIndicator.js.map