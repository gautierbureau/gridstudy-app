/**
 * Copyright (c) 2021, RTE (http://www.rte-france.com)
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { NodeProps, Position } from '@xyflow/react';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import { useSelector } from 'react-redux';
import Box from '@mui/material/Box';
import {
    copyToClipboard,
    LIGHT_THEME,
    type MuiStyles,
    useSnackMessage,
    BuildStatusChip,
    BuildStatus,
} from '@gridsuite/commons-ui';
import { getLocalStorageTheme } from '../../../redux/session-storage/local-storage';
import { AppState } from 'redux/reducer.type';
import { CopyType } from 'components/network-modification.type';
import { ModificationNode } from '../tree-node.type';
import NodeHandle from './node-handle';
import { baseNodeStyles, interactiveNodeStyles } from './styles';
import NodeOverlaySpinner from './node-overlay-spinner';

import { BuildButton } from './build-button';
import { Tooltip, Typography } from '@mui/material';
import { useIntl } from 'react-intl';
import { memo, type MouseEvent, useCallback, useMemo } from 'react';
import { TOOLTIP_DELAY } from 'utils/UIconstants';
import ForwardRefBox from 'components/utils/forwardRefBox';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';

const styles = {
    networkModificationSelected: (theme) => ({
        ...baseNodeStyles(theme, 'column'),
        background: theme.node.modification.selectedBackground,
        border: theme.node.modification.selectedBorder,
        boxShadow: theme.shadows[6],
        ...interactiveNodeStyles(theme, 'modification'),
    }),
    networkModification: (theme) => ({
        ...baseNodeStyles(theme, 'column'),
        border: theme.node.modification.border,
        ...interactiveNodeStyles(theme, 'modification'),
    }),
    contentBox: (theme) => ({
        flexGrow: 1,
        display: 'flex',
        alignItems: 'flex-end',
        marginLeft: theme.spacing(1),
        marginRight: theme.spacing(1),
        marginBottom: theme.spacing(1),
    }),
    typographyText: (theme) => ({
        color: theme.palette.text.primary,
        fontSize: '20px',
        fontWeight: 400,
        lineHeight: 'normal',
        textAlign: 'left',
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 2,
        overflow: 'hidden',
        width: 'auto',
        textOverflow: 'ellipsis',
        wordBreak: 'break-word',
    }),
    footerBox: (theme) => ({
        display: 'flex',
        justifyContent: 'flex-start',
        marginLeft: theme.spacing(1),
        height: '35%',
    }),
    buildBox: (theme) => ({
        display: 'flex',
        justifyContent: 'flex-end',
        marginTop: theme.spacing(-5),
        marginRight: theme.spacing(0),
        height: '35%',
    }),
    chipFloating: (theme) => ({
        position: 'absolute',
        top: theme.spacing(-4),
        left: theme.spacing(1),
        zIndex: 2,
    }),
    tooltip: {
        maxWidth: '720px',
    },
} as const satisfies MuiStyles;

// stable references hoisted out of the render path: every tree node renders one of
// these Tooltips, and any inline object/handler defeats their memoization
const tooltipComponentsProps = { tooltip: { sx: styles.tooltip } };
const stopPropagation = (e: MouseEvent) => e.stopPropagation();

const NetworkModificationNode = (props: NodeProps<ModificationNode>) => {
    // Select derived booleans, not the raw currentTreeNode/nodeSelectionForCopy objects:
    // those references change on every selection, which re-rendered all N tree nodes on
    // each click. With booleans, only the nodes whose state actually flips re-render.
    const isSelected = useSelector((state: AppState) => props.id === state.currentTreeNode?.id);
    const isSelectedForCut = useSelector((state: AppState) => {
        const selectionForCopy = state.nodeSelectionForCopy;
        return (
            (props.id === selectionForCopy?.nodeId && selectionForCopy?.copyType === CopyType.NODE_CUT) ||
            ((props.id === selectionForCopy?.nodeId ||
                (selectionForCopy.allChildren?.some((child) => child.id === props.id) ?? false)) &&
                selectionForCopy?.copyType === CopyType.SUBTREE_CUT)
        );
    });
    const studyUuid = useSelector((state: AppState) => state.studyUuid);
    const currentRootNetworkUuid = useSelector((state: AppState) => state.currentRootNetworkUuid);
    const { snackError, snackInfo } = useSnackMessage();

    const intl = useIntl();

    const onClipboardCopy = useCallback(() => {
        snackInfo({ headerId: 'uuidCopiedToClipboard' });
    }, [snackInfo]);

    const onClipboardError = useCallback(() => {
        snackError({ headerId: 'uuidCopiedToClipboardError' });
    }, [snackError]);

    const tooltipContent = useMemo(() => {
        return (
            <Box style={{ whiteSpace: 'pre-line' }}>
                <Box>{props.data.label}</Box>
                <Box>
                    {intl.formatMessage({ id: 'nodeStatus' })} :{' '}
                    {props.data.globalBuildStatus
                        ? intl.formatMessage({ id: props.data.globalBuildStatus })
                        : intl.formatMessage({ id: 'NOT_BUILT' })}
                </Box>
                <Box>
                    {intl.formatMessage({ id: 'nodeType' })} : {intl.formatMessage({ id: props.data.nodeType })}
                </Box>
                <Box
                    sx={{
                        cursor: 'pointer',
                        height: '30px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                    }}
                    onClick={() => copyToClipboard(props.id, onClipboardCopy, onClipboardError)}
                >
                    {intl.formatMessage({ id: 'uuid' })}
                    <ContentCopyIcon fontSize="small" />
                </Box>
            </Box>
        );
    }, [props.data, props.id, intl, onClipboardCopy, onClipboardError]);

    const nodeOpacity = isSelectedForCut ? (getLocalStorageTheme() === LIGHT_THEME ? 0.3 : 0.6) : 'unset';
    const nodeSx = useMemo(
        () => [isSelected ? styles.networkModificationSelected : styles.networkModification, { opacity: nodeOpacity }],
        [isSelected, nodeOpacity]
    );

    return (
        <>
            <NodeHandle type={'source'} position={Position.Bottom} />
            <NodeHandle type={'target'} position={Position.Top} />

            {props.data.globalBuildStatus !== props.data.localBuildStatus && (
                <BuildStatusChip
                    buildStatus={props.data.globalBuildStatus}
                    sx={styles.chipFloating}
                    icon={<ArrowUpwardIcon style={{ fontSize: '14px' }} color="inherit" />}
                    onClick={stopPropagation}
                />
            )}

            <Tooltip
                title={tooltipContent}
                disableFocusListener
                disableTouchListener
                componentsProps={tooltipComponentsProps}
                arrow
                enterDelay={TOOLTIP_DELAY}
                enterNextDelay={TOOLTIP_DELAY}
                placement="left"
            >
                <ForwardRefBox sx={nodeSx}>
                    <Box sx={styles.contentBox}>
                        <Typography variant="body1" sx={styles.typographyText}>
                            {props.data.label}
                        </Typography>
                    </Box>

                    <Box sx={styles.footerBox}>
                        {props.data.globalBuildStatus !== BuildStatus.BUILDING && (
                            <BuildStatusChip buildStatus={props.data.localBuildStatus} />
                        )}
                    </Box>

                    <Box sx={styles.buildBox}>
                        {props.data.localBuildStatus !== BuildStatus.BUILDING && (
                            <BuildButton
                                buildStatus={props.data.localBuildStatus}
                                studyUuid={studyUuid}
                                currentRootNetworkUuid={currentRootNetworkUuid}
                                nodeUuid={props.id}
                            />
                        )}
                    </Box>

                    {props.data.localBuildStatus === BuildStatus.BUILDING && <NodeOverlaySpinner />}
                </ForwardRefBox>
            </Tooltip>
        </>
    );
};

// memoized: xyflow re-renders node components whenever the parent tree renders;
// with stable props and the boolean selectors above, unaffected nodes bail out
export default memo(NetworkModificationNode);
