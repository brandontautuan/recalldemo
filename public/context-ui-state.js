export const createMeetingContextState = () => ({
  projectId: '',
  projectContext: '',
  preview: null,
  previewProjectContext: null,
  busy: null,
  error: null,
});

export function updateMeetingContext(state, changes) {
  const projectId = changes.projectId ?? state.projectId;
  const projectContext = changes.projectContext ?? state.projectContext;
  const previewChanged = projectId !== state.projectId || projectContext !== state.projectContext;
  return {
    ...state,
    ...changes,
    projectId,
    projectContext,
    preview: previewChanged ? null : state.preview,
    previewProjectContext: previewChanged ? null : state.previewProjectContext,
    error: null,
  };
}

export const contextPreviewIsCurrent = (state) => Boolean(
  state.projectId
  && state.preview
  && state.preview.projectId === state.projectId
  && state.previewProjectContext === state.projectContext
  && !state.preview.analysisId
);

export const contextPreviewIsApproved = (state) => contextPreviewIsCurrent(state) && Boolean(state.preview.approvedAt);

export function saveContextPreview(state, preview) {
  if (!preview || preview.projectId !== state.projectId) throw new Error('Context preview does not match the selected project.');
  return { ...state, preview, previewProjectContext: state.projectContext, busy: null, error: null };
}

export function approveContextPreview(state, preview) {
  if (!contextPreviewIsCurrent(state) || preview?.id !== state.preview.id || !preview.approvedAt) throw new Error('Approved context does not match the current preview.');
  return { ...state, preview, busy: null, error: null };
}

export function contextPreviewPayload(state) {
  if (!state.projectId) throw new Error('Select a project before creating a context preview.');
  return { projectId: state.projectId, projectContext: state.projectContext };
}

export function manualAnalysisPayload(state) {
  if (!state.projectId) return { projectContext: state.projectContext };
  if (!contextPreviewIsApproved(state)) throw new Error('Create and approve a current context preview before analysis.');
  return { contextSelectionId: state.preview.id, projectContext: state.projectContext };
}
