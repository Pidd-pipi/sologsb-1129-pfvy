import { createBrowserRouter, Navigate } from 'react-router-dom';
import AppShell from '../layouts/AppShell';
import Overview from '../pages/Overview';
import MatrixNew from '../pages/MatrixNew';
import MatrixDetail from '../pages/MatrixDetail';
import CaseEditor from '../pages/CaseEditor';
import DefectBoard from '../pages/DefectBoard';
import ProofList from '../pages/ProofList';
import RecutBoard from '../pages/RecutBoard';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Overview /> },
      { path: 'matrices/new', element: <MatrixNew /> },
      { path: 'matrices/:id', element: <MatrixDetail /> },
      { path: 'cases', element: <CaseEditor /> },
      { path: 'defects', element: <DefectBoard /> },
      { path: 'recuts', element: <RecutBoard /> },
      { path: 'proofs', element: <ProofList /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default router;
