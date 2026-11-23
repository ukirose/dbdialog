import {
  CommentIcon,
  ScreenFullIcon,
  WorkflowIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from '@primer/octicons-react';
import { Button, IconButton, SegmentedControl } from '@primer/react';
import { useReactFlow, useStore } from '@xyflow/react';
import type { Notation } from '../../core/view';
import { t } from '../i18n';

const NOTATIONS: { value: Notation; label: string }[] = [
  { value: 'ie', label: 'IE' },
  { value: 'idef1x', label: 'IDEF1X' },
];

/** The floating bar at the bottom of the canvas: zoom, fit, automatic layout, comments, notation. */
export function CanvasToolbar(props: {
  showComments: boolean;
  onToggleComments: () => void;
  onFit: () => void;
  onRelayout: () => void;
  notation: Notation;
  onNotation: (notation: Notation) => void;
}) {
  const flow = useReactFlow();
  const zoom = useStore((s) => s.transform[2]);
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label={t('toolbar.view')}>
      <IconButton
        icon={ZoomOutIcon}
        aria-label={t('toolbar.zoomOut')}
        size="small"
        variant="invisible"
        onClick={() => flow.zoomOut({ duration: 150 })}
      />
      <Button
        size="small"
        variant="invisible"
        className="zoom-level"
        title={t('toolbar.zoomReset')}
        onClick={() => flow.zoomTo(1, { duration: 150 })}
      >
        {Math.round(zoom * 100)}%
      </Button>
      <IconButton
        icon={ZoomInIcon}
        aria-label={t('toolbar.zoomIn')}
        size="small"
        variant="invisible"
        onClick={() => flow.zoomIn({ duration: 150 })}
      />
      <span className="canvas-toolbar-sep" aria-hidden="true" />
      <Button size="small" variant="invisible" leadingVisual={ScreenFullIcon} onClick={props.onFit}>
        {t('toolbar.fit')}
      </Button>
      <Button
        size="small"
        variant="invisible"
        leadingVisual={WorkflowIcon}
        onClick={props.onRelayout}
      >
        {t('toolbar.relayout')}
      </Button>
      <Button
        size="small"
        variant="invisible"
        leadingVisual={CommentIcon}
        aria-pressed={props.showComments}
        onClick={props.onToggleComments}
      >
        {t('toolbar.comments')}
      </Button>
      <span className="canvas-toolbar-sep" aria-hidden="true" />
      <span className="canvas-toolbar-label" aria-hidden="true">
        {t('toolbar.notation')}
      </span>
      <SegmentedControl
        aria-label={t('toolbar.notation')}
        size="small"
        onChange={(i) => props.onNotation(NOTATIONS[i]?.value ?? 'ie')}
      >
        {NOTATIONS.map((n) => (
          <SegmentedControl.Button key={n.value} selected={props.notation === n.value}>
            {n.label}
          </SegmentedControl.Button>
        ))}
      </SegmentedControl>
    </div>
  );
}
