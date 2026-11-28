import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Render the tab title's terminal prompt in the surrounding text color.
 * @returns a decorative sixteen-pixel line glyph.
 */
export function TerminalIcon() {
    return _jsx("svg", { width: "16", height: "16", viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: _jsx("path", { d: "m3 4 4 4-4 4M9 12h4", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }) });
}
/**
 * Render the guide's terminal card within the folder glyph's painted bounds.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns a dark rounded terminal card with a white prompt.
 */
export function TerminalGuideIcon({ size = 26, className }) {
    return _jsxs("svg", { width: size, height: size, className: className, viewBox: "0 0 28 28", fill: "none", "aria-hidden": "true", children: [_jsx("rect", { x: "3", y: "5", width: "22", height: "19", rx: "3", fill: "#17191d" }), _jsx("path", { d: "m8 10 4 4-4 4M15 18h5", stroke: "#fff", strokeWidth: "1.7", strokeLinecap: "round", strokeLinejoin: "round" })] });
}
//# sourceMappingURL=TerminalIcon.js.map