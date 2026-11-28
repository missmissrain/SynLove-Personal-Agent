import { jsx as _jsx } from "react/jsx-runtime";
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives';
/** The tab kind this package owns. */
export const FILES_KIND = 'files';
/** This implementation's identity in the tab system, and the key its body registers under. */
export const FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files';
/** The type's coloured folder sheet at the guide capsule's glyph size, as the chip title draws it. */
function FolderSheetGlyph({ size, className }) {
    return _jsx(FileTypeIcon, { kind: "folder", size: size, className: className });
}
/**
 * The files type's registry definition.
 * @param t - namespace-bound translate, read fresh on every label call.
 * @returns the definition to register.
 */
export function filesDefinition(t) {
    return {
        id: FILES_ID,
        kind: FILES_KIND,
        priority: 'builtin',
        title: () => t('type.label'),
        guide: [{
                id: 'workspace',
                order: 10,
                title: () => t('guide.title'),
                description: () => t('guide.description'),
                icon: FolderSheetGlyph,
            }],
    };
}
//# sourceMappingURL=definition.js.map