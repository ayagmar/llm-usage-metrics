import { parseReportData, REPORT_DATA_ELEMENT_ID } from '../core/index.js';

const payload = parseReportData(document.getElementById(REPORT_DATA_ELEMENT_ID)?.textContent);
document.documentElement.dataset.reportReady = payload === undefined ? 'false' : 'true';
