/**
 * Copyright (c) 2024, RTE (http://www.rte-france.com)
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import type { UUID } from 'node:crypto';
import { useEffect, useState } from 'react';
import { type Identifiable } from '@gridsuite/commons-ui';
import { fetchVoltageLevelsListInfos } from '../services/study/network';

export default function useVoltageLevelsListInfos(studyUuid: UUID, nodeUuid: UUID, currentRootNetworkUuid: UUID) {
    const [voltageLevelsListInfos, setVoltageLevelsListInfos] = useState<Identifiable[]>([]);
    useEffect(() => {
        if (studyUuid && nodeUuid && currentRootNetworkUuid) {
            // guard against out-of-order responses on rapid node/root-network switches:
            // without it, an older in-flight response can overwrite the newer list
            let cancelled = false;
            fetchVoltageLevelsListInfos(studyUuid, nodeUuid, currentRootNetworkUuid).then((values) => {
                if (!cancelled) {
                    setVoltageLevelsListInfos(values.sort((a, b) => a.id.localeCompare(b.id)));
                }
            });
            return () => {
                cancelled = true;
            };
        }
    }, [studyUuid, nodeUuid, currentRootNetworkUuid]);
    return voltageLevelsListInfos;
}
