import { useState, useEffect, useRef } from 'react';
import { ScanBarcode, Box, AlertCircle, HardHat, Loader2, Download, Check, AlertTriangle, List } from 'lucide-react';
import Papa from 'papaparse';
import './index.css';

const GOOGLE_SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/1GEFOY44VXGluWv_lCBBFZzpsHWuP4DwN6Ge7OnYEIOc/export?format=csv";
const GONDOLA_MAX_LENGTH = 3000; // 3 metros (3000mm) por gôndola

export default function App() {
  const [allocation, setAllocation] = useState({});
  const [gondolas, setGondolas] = useState([]);
  const [scannedPieces, setScannedPieces] = useState([]);
  const [projectPieces, setProjectPieces] = useState([]);
  const [environments, setEnvironments] = useState({});
  
  const [loading, setLoading] = useState(true);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [lastScanned, setLastScanned] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [outOfSpaceError, setOutOfSpaceError] = useState(false);
  
  // Estados para Recusa de Peça
  const [rejectedPieces, setRejectedPieces] = useState([]);
  const [reportingDefect, setReportingDefect] = useState(false);
  const [defectReason, setDefectReason] = useState('');
  
  const SPACING = 80;
  const [historicalState, setHistoricalState] = useState(() => {
    const saved = localStorage.getItem('gondolaHistory');
    if (saved) return JSON.parse(saved);
    return {};
  });
  const [showZerarModal, setShowZerarModal] = useState(false);
  
  const [currentClient, setCurrentClient] = useState('Cliente Desconhecido');
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [isUpdatingReport, setIsUpdatingReport] = useState(false);
  const [gondolaExtraSpaces, setGondolaExtraSpaces] = useState({});
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw6JIya9obA03F8SkW7TIfmrsalMLyIhh1OEuH6CvqTMYK7PtLoPauthj5ZjdN5Rlme/exec";
  
  const [suspendedProjects, setSuspendedProjects] = useState(() => {
    const saved = localStorage.getItem('suspendedProjects');
    if (saved) return JSON.parse(saved);
    return [];
  });

  const getSuspendedReservations = (suspendedList) => {
    const reservations = {};
    suspendedList.forEach(proj => {
      const projEnv = proj.environments;
      for (const envName in projEnv) {
        for (const modId in projEnv[envName]) {
          const mod = projEnv[envName][modId];
          if (!mod.pieces || mod.pieces.length === 0) continue;
          
          const firstPiece = mod.pieces[0];
          const gondolaId = proj.allocation[firstPiece.displayId];
          if (!gondolaId) continue;

          const minDims = mod.pieces.map(p => Math.min(p.comprimento, p.largura));
          const maxWidth = Math.max(...minDims);
          const space = maxWidth + SPACING; // SPACING é 80

          reservations[gondolaId] = (reservations[gondolaId] || 0) + space;
        }
      }
    });
    return reservations;
  };
  
  const inputRef = useRef(null);

  const [passwordModal, setPasswordModal] = useState({ isOpen: false, expectedPassword: '', message: '', onSuccess: null });
  const [passwordInputValue, setPasswordInputValue] = useState('');
  const [passwordInputError, setPasswordInputError] = useState(false);

  // Helper para verificação de senhas com modal customizado e mascarado
  const requestPassword = (expectedPassword, message, onSuccess) => {
    setPasswordModal({
      isOpen: true,
      expectedPassword,
      message,
      onSuccess
    });
    setPasswordInputValue('');
    setPasswordInputError(false);
  };

  const handleConfirmPassword = () => {
    if (passwordInputValue === passwordModal.expectedPassword) {
      const successCallback = passwordModal.onSuccess;
      setPasswordModal({ isOpen: false, expectedPassword: '', message: '', onSuccess: null });
      if (successCallback) successCallback();
    } else {
      setPasswordInputError(true);
      alert("Senha incorreta!");
    }
  };

  const handleAdicionarEspacoGondola = (gondolaId) => {
    const g = gondolas.find(item => item.id === gondolaId);
    if (!g) return;
    
    const extraSpace = gondolaExtraSpaces[gondolaId] || 0;
    const freeSpaceMm = g.capacity - (g.used + extraSpace);
    const freeSpaceM = freeSpaceMm / 1000;
    
    const input = prompt(`Digite o espaço a adicionar na Gôndola ${gondolaId} em metros (ex: 0.5 para 50cm, 1.2 para 1.20m):\n\nEspaço livre restante: ${freeSpaceM.toFixed(2)}m`);
    if (input === null) return; // Cancelado
    
    const val = parseFloat(input.replace(',', '.'));
    if (isNaN(val) || val <= 0) {
      alert("Valor inválido!");
      return;
    }
    
    const valMm = Math.round(val * 1000);
    
    if (valMm > freeSpaceMm) {
      alert(`Esse valor de ${val.toFixed(2)}m não cabe na gôndola! O espaço livre restante é de apenas ${freeSpaceM.toFixed(2)}m.`);
      return;
    }
    
    setGondolaExtraSpaces(prev => ({
      ...prev,
      [gondolaId]: (prev[gondolaId] || 0) + valMm
    }));
  };

  // --- SALVAMENTO AUTOMÁTICO EM REAL-TIME ---
  useEffect(() => {
    if (currentClient && currentClient !== 'Cliente Desconhecido') {
      localStorage.setItem('scannedPieces', JSON.stringify(scannedPieces));
    }
  }, [scannedPieces, currentClient]);

  useEffect(() => {
    if (currentClient && currentClient !== 'Cliente Desconhecido') {
      localStorage.setItem('rejectedPieces', JSON.stringify(rejectedPieces));
    }
  }, [rejectedPieces, currentClient]);

  // 1. Carregar Planilha Real e Rodar Motor de Inteligência
  const carregarDadosProjeto = () => {
    setLoading(true);
    setErrorMsg('');
    // Use cache-busting to bypass aggressive browser caching of Google Sheet exports
    const cacheBusterUrl = `${GOOGLE_SHEET_CSV_URL}&t=${Date.now()}`;
    Papa.parse(cacheBusterUrl, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        let rawPieces = [];
        const moduleNames = {}; // Mapa para guardar o nome real de cada módulo { id: 'nome' }
        let foundClient = '';

        // PASSAGEM 1: Extrair dados brutos e mapear todos os IDs de módulos válidos
        results.data.forEach(row => {
          if (!foundClient && (row["cliente"] || row["Cliente"] || row["CLIENTE"])) {
            foundClient = row["cliente"] || row["Cliente"] || row["CLIENTE"];
          }
          
          const comp = parseFloat(row["altura"]) || 0;
          const larg = parseFloat(row["largura"]) || 0;

          // Se a peça não possuir dimensões físicas válidas (comprimento e largura > 0), ignora a linha
          if (comp <= 0 || larg <= 0) {
            return;
          }
          
          const moduloId = row["ID do Módulo"] || 'Avulso';
          const moduloNome = row["Descrição do módulo"] || 'Módulo Avulso';
          
          // Sempre salva o nome do módulo para que ele exista na lista de Pais válidos!
          // Isso resolve o problema de pais que só contêm "CRU" sumirem do radar.
          if (!moduleNames[moduloId]) {
            moduleNames[moduloId] = moduloNome;
          }

          let barcodeNum = row["ID no RP / cod de barras"]?.trim() || '';
          let barcodeFuracao = row["Código de Barras / Cod da furação"]?.trim() || '';
          const esp = parseFloat(row["esp"]) || parseFloat(row["esp da chapa"]) || 15;
          
          let hasNumericNum = barcodeNum && !/[a-zA-Z]/.test(barcodeNum);
          let hasNumericFuracao = barcodeFuracao && !/[a-zA-Z]/.test(barcodeFuracao);

          let finalDisplayId = '';

          if (hasNumericNum) {
            finalDisplayId = barcodeNum;
          } else if (hasNumericFuracao) {
            finalDisplayId = barcodeFuracao;
          } else {
            // Nenhum dos dois é um código numérico puro. Então a peça fica sem código de barras.
            finalDisplayId = 'SEM_CODIGO';
          }

          // Só adiciona se o comprimento for um número válido (peças de madeira)
          if (!isNaN(comp)) {
            let nomePeca = row["Descrição do item no RP"] || 'Desconhecido';
            const material = row["Desc do Mat"] || '';

            // Ignorar tampos crus conforme solicitado
            if (nomePeca.toUpperCase().includes('CRU') || material.toUpperCase().includes('CRU')) {
              return;
            }

            rawPieces.push({
              id1: hasNumericNum ? barcodeNum : '',
              id2: hasNumericFuracao ? barcodeFuracao : '',
              displayId: finalDisplayId,
              nome: nomePeca,
              moduloId: moduloId,
              modulo: moduloNome,
              ambiente: row["Comodo"] || 'Sem Ambiente',
              comprimento: comp,
              largura: larg,
              espessura: esp
            });
          }
        });

        // PASSAGEM 2: Descobrir Anexações de Módulos Inteiros (Se uma peça tem o ID, o módulo todo vai pro pai)
        const validModuleIds = Object.keys(moduleNames).sort((a, b) => b.length - a.length);
        const moduleRedirects = {}; // { "idModulo_ambiente": idModuloPai }

        rawPieces.forEach(peca => {
          const redirectKey = peca.moduloId + '_' + peca.ambiente;
          if (peca.moduloId !== 'Avulso' && !moduleRedirects[redirectKey]) {
            for (const possibleParentId of validModuleIds) {
              if (possibleParentId === peca.moduloId) continue;

              const regex = new RegExp(`\\b${possibleParentId}\\b`);
              if (regex.test(peca.nome)) {
                // Descobrimos que este módulo (neste ambiente) pertence ao Pai!
                moduleRedirects[redirectKey] = possibleParentId;
                break;
              }
            }
          }
        });

        // PASSAGEM 3: Aplicar as Anexações e Filtrar Gôndolas Especiais
        const parsedPieces = [];
        const envHierarchy = {};
        const modules = {};
        const moduleRedirectsApplied = [];

        rawPieces.forEach(peca => {
          const redirectKey = peca.moduloId + '_' + peca.ambiente;
          let finalModuloId = moduleRedirects[redirectKey] || peca.moduloId;
          peca.moduloId = finalModuloId;
          peca.modulo = moduleNames[finalModuloId] || peca.modulo;
          moduleRedirectsApplied.push(peca);
          
          if (!modules[peca.moduloId]) modules[peca.moduloId] = [];
          modules[peca.moduloId].push(peca);
        });

        // 3.1 Identificar Módulos da Gôndola Expedição
        const expedicaoModIds = new Set();
        Object.keys(modules).forEach(modId => {
          const pieces = modules[modId];
          const modName = pieces[0].modulo.toUpperCase();
          if (modName.includes('DOR_ARM')) {
            expedicaoModIds.add(modId);
          } else if (modName.includes('CANTO L') && pieces.some(p => p.comprimento > 2000)) {
            expedicaoModIds.add(modId);
          }
        });

        const gigantesPieces = [];
        const grandesPiecesByEnv = {};

        moduleRedirectsApplied.forEach(peca => {
          parsedPieces.push(peca);
          
          // Se for expedição, ignora regras de peças grandes/gigantes e vai inteiro pra lá
          if (expedicaoModIds.has(peca.moduloId)) {
            if (!envHierarchy[peca.ambiente]) envHierarchy[peca.ambiente] = {};
            if (!envHierarchy[peca.ambiente][peca.moduloId]) {
              envHierarchy[peca.ambiente][peca.moduloId] = { nome: peca.modulo, pieces: [], isExpedicao: true };
            }
            envHierarchy[peca.ambiente][peca.moduloId].pieces.push(peca);
            return; // Já alocou no módulo Expedição
          }

          const isFundo = peca.nome.includes('6.50');
          const minDim = Math.min(peca.comprimento, peca.largura);

          // 3.2 Regra Gigantes
          if (!isFundo && minDim > 1500) {
            gigantesPieces.push(peca);
            return;
          }

          // 3.3 Regra Grandes
          if (minDim > 1000) {
            if (!grandesPiecesByEnv[peca.ambiente]) grandesPiecesByEnv[peca.ambiente] = [];
            grandesPiecesByEnv[peca.ambiente].push(peca);
            return;
          }

          // 3.4 Peças Comuns
          if (!envHierarchy[peca.ambiente]) envHierarchy[peca.ambiente] = {};
          if (!envHierarchy[peca.ambiente][peca.moduloId]) {
            envHierarchy[peca.ambiente][peca.moduloId] = { nome: peca.modulo, pieces: [] };
          }
          envHierarchy[peca.ambiente][peca.moduloId].pieces.push(peca);
        });

        setProjectPieces(parsedPieces);
        const resolvedClient = foundClient || 'Projeto sem nome';
        setCurrentClient(resolvedClient);

        // Recuperar bipes salvos do localStorage se for o mesmo cliente
        const lastSavedClient = localStorage.getItem('lastClientName');
        if (resolvedClient === lastSavedClient) {
          const savedScanned = localStorage.getItem('scannedPieces');
          if (savedScanned) {
            try {
              setScannedPieces(JSON.parse(savedScanned));
            } catch (err) {
              console.error("Erro ao ler scannedPieces do localStorage", err);
            }
          }
          const savedRejected = localStorage.getItem('rejectedPieces');
          if (savedRejected) {
            try {
              setRejectedPieces(JSON.parse(savedRejected));
            } catch (err) {
              console.error("Erro ao ler rejectedPieces do localStorage", err);
            }
          }
        } else {
          // É um novo projeto! Limpar bipes e rejeitados antigos
          setScannedPieces([]);
          setRejectedPieces([]);
          localStorage.setItem('lastClientName', resolvedClient);
          localStorage.setItem('scannedPieces', JSON.stringify([]));
          localStorage.setItem('rejectedPieces', JSON.stringify([]));
        }

        // PASSAGEM 4: Agrupamento Inteligente de Peças (Órfãs, Gigantes, Grandes)
        const generateStacks = (piecesList, stackNamePrefix, startStackId, envName) => {
          piecesList.sort((a, b) => {
            if (b.largura !== a.largura) return b.largura - a.largura;
            return b.comprimento - a.comprimento;
          });
          
          const stacks = {};
          let virtualStackId = startStackId;
          let pieces = [...piecesList];
          
          while (pieces.length > 0) {
            const basePiece = pieces.shift();
            const stackBaseWidth = basePiece.largura;
            const stackId = `PILHA_${envName}_${virtualStackId++}`;
            const stack = {
              id: stackId,
              nome: stackNamePrefix,
              pieces: [basePiece],
              thickness: basePiece.espessura
            };
            
            while (pieces.length > 0) {
              let layerWidth = 0;
              let layerMaxThickness = 0;
              const layerPieces = [];
              const remainingPieces = [];
              
              for (const p of pieces) {
                if (layerWidth + p.largura <= stackBaseWidth) {
                  layerWidth += p.largura;
                  layerMaxThickness = Math.max(layerMaxThickness, p.espessura);
                  layerPieces.push(p);
                } else {
                  remainingPieces.push(p);
                }
              }
              
              if (layerPieces.length === 0) break; 
              
              if (stack.thickness + layerMaxThickness <= 300) {
                stack.pieces.push(...layerPieces);
                stack.thickness += layerMaxThickness;
                pieces = remainingPieces;
              } else {
                break;
              }
            }
            
            stack.pieces.forEach(p => {
              p.moduloId = stack.id;
              p.modulo = stack.nome;
              if (envName !== 'GIGANTES_GLOBAL') p.ambiente = envName; // Corrige ambiente
            });
            stacks[stack.id] = stack;
          }
          return { stacks, nextId: virtualStackId };
        };

        let nextVirtualId = 1;

        // Processar Gigantes
        const gigantesStacks = {};
        if (gigantesPieces.length > 0) {
          const res = generateStacks(gigantesPieces, 'Pilha de Peças Gigantes', nextVirtualId, 'GIGANTES_GLOBAL');
          Object.assign(gigantesStacks, res.stacks);
          nextVirtualId = res.nextId;
        }

        // Processar Grandes (Agrupado por ambiente)
        const grandesStacksByEnv = {};
        for (const env in grandesPiecesByEnv) {
          grandesStacksByEnv[env] = {};
          const res = generateStacks(grandesPiecesByEnv[env], `Pilha de Peças Grandes`, nextVirtualId, env);
          Object.assign(grandesStacksByEnv[env], res.stacks);
          nextVirtualId = res.nextId;
        }

        // Processar Órfãs Normais
        for (const envName in envHierarchy) {
          const env = envHierarchy[envName];
          const orphanPieces = [];
          const validModules = {};
          
          for (const modId in env) {
            const mod = env[modId];
            if (mod.isExpedicao) {
              validModules[modId] = mod;
              continue;
            }
            if (mod.pieces.length === 1) {
              orphanPieces.push(mod.pieces[0]);
            } else {
              validModules[modId] = mod;
            }
          }
          
          if (orphanPieces.length > 0) {
            const modsToDismantle = [];
            for (const mId in validModules) {
              if (validModules[mId].isExpedicao) continue; // Nunca desmancha expedição
              const modName = validModules[mId].nome.toUpperCase().trim();
              if (modName.startsWith('TAMPO 30MM') || modName.startsWith('FECHAMENTO EXTERNO') || modName.startsWith('PORTA ')) {
                modsToDismantle.push(mId);
              }
            }
            
            modsToDismantle.forEach(mId => {
              orphanPieces.push(...validModules[mId].pieces);
              delete validModules[mId];
            });

            const res = generateStacks(orphanPieces, 'Pilha de Peças Órfãs', nextVirtualId, envName);
            Object.assign(validModules, res.stacks);
            nextVirtualId = res.nextId;
          }
          
          envHierarchy[envName] = validModules;
        }

        // Injetar Grandes no Hierarchy normal (pois são divididas por ambiente)
        for (const envName in grandesStacksByEnv) {
          if (!envHierarchy[envName]) envHierarchy[envName] = {};
          Object.assign(envHierarchy[envName], grandesStacksByEnv[envName]);
        }
        
        // Injetar Gigantes num ambiente virtual (pois não têm ambiente)
        if (Object.keys(gigantesStacks).length > 0) {
          envHierarchy['PEÇAS GIGANTES'] = gigantesStacks;
        }

        setEnvironments(envHierarchy);

        // PASSAGEM 5: Alocação nas Gôndolas
        const reservations = getSuspendedReservations(suspendedProjects);
        
        let tempGondolas = [
          ...Array.from({length: 7}, (_, i) => {
            const id = (i + 1).toString();
            const resSpace = reservations[id] || 0;
            return { id, capacity: 5530, historical: historicalState[id] || 0, current: 0, used: (historicalState[id] || 0) + resSpace, reserved: resSpace, isSpecial: false };
          }),
          { id: 'Expedição', capacity: 7760, historical: historicalState['Expedição'] || 0, current: 0, used: (historicalState['Expedição'] || 0) + (reservations['Expedição'] || 0), reserved: reservations['Expedição'] || 0, isSpecial: true },
          { id: 'Peças Grandes', capacity: 5200, historical: historicalState['Peças Grandes'] || 0, current: 0, used: (historicalState['Peças Grandes'] || 0) + (reservations['Peças Grandes'] || 0), reserved: reservations['Peças Grandes'] || 0, isSpecial: true },
          { id: 'Peças Gigantes', capacity: 1840, historical: historicalState['Peças Gigantes'] || 0, current: 0, used: (historicalState['Peças Gigantes'] || 0) + (reservations['Peças Gigantes'] || 0), reserved: reservations['Peças Gigantes'] || 0, isSpecial: true }
        ];

        // Carregar gôndolas de transbordo excedente já salvas no histórico
        Object.keys(historicalState).forEach(key => {
          if (key.startsWith('Transbordo Excedente')) {
            const resSpace = reservations[key] || 0;
            tempGondolas.push({
              id: key,
              capacity: 5530,
              historical: historicalState[key] || 0,
              current: 0,
              used: (historicalState[key] || 0) + resSpace,
              reserved: resSpace,
              isSpecial: true,
              isTemporary: true
            });
          }
        });
        
        const currentAllocation = {};

        if (Object.keys(envHierarchy).length > 0) {
          // Construir a lista de todos os módulos com seus tamanhos calculados
          let allModules = [];
          for (const envName in envHierarchy) {
            for (const modId in envHierarchy[envName]) {
              const mod = envHierarchy[envName][modId];
              const minDims = mod.pieces.map(p => Math.min(p.comprimento, p.largura));
              const maxWidth = Math.max(...minDims);
              const totalSpace = maxWidth + SPACING;
              allModules.push({
                envName,
                modId,
                nome: mod.nome,
                pieces: mod.pieces,
                space: totalSpace,
                isExpedicao: mod.isExpedicao,
                isGigante: envName === 'PEÇAS GIGANTES',
                isGrande: mod.nome.includes('Pilha de Peças Grandes')
              });
            }
          }

          // 5.1 Alocar Especiais Primeiro
          allModules.forEach(mod => {
            let targetGondolaName = null;
            if (mod.isExpedicao) targetGondolaName = 'Expedição';
            else if (mod.isGigante) targetGondolaName = 'Peças Gigantes';
            else if (mod.isGrande) targetGondolaName = 'Peças Grandes';

            if (targetGondolaName) {
              const gondola = tempGondolas.find(g => g.id === targetGondolaName);
              gondola.used += mod.space;
              gondola.current += mod.space;
              mod.pieces.forEach(p => { currentAllocation[p.displayId] = gondola.id; });
              mod.allocated = true; // Marca como resolvido
            }
          });

          // 5.2 Alocar o restante nas Genéricas por Ambiente
          const normalModules = allModules.filter(m => !m.allocated);
          // Agrupar por ambiente para o algoritmo de bin packing
          const normalEnvs = {};
          normalModules.forEach(m => {
            if (!normalEnvs[m.envName]) normalEnvs[m.envName] = { name: m.envName, modules: [], totalSpace: 0 };
            normalEnvs[m.envName].modules.push(m);
            normalEnvs[m.envName].totalSpace += m.space;
          });

          const environmentsList = Object.values(normalEnvs).sort((a, b) => b.totalSpace - a.totalSpace);
          const genericGondolas = tempGondolas.filter(g => !g.isSpecial);

          for (const env of environmentsList) {
            let targetGondola = genericGondolas.find(g => g.used + env.totalSpace <= g.capacity);
            if (targetGondola) {
              for (const mod of env.modules) {
                targetGondola.used += mod.space;
                targetGondola.current += mod.space;
                mod.pieces.forEach(p => { currentAllocation[p.displayId] = targetGondola.id; });
              }
            } else {
              // Quebrar módulos
              for (const mod of env.modules) {
                let modGondola = genericGondolas.find(g => g.used + mod.space <= g.capacity);
                 if (!modGondola) {
                   let transbordoGondolas = tempGondolas.filter(g => g.id.startsWith('Transbordo Excedente'));
                   let foundTransbordo = transbordoGondolas.find(g => g.used + mod.space <= g.capacity);
                   if (!foundTransbordo) {
                     const nextNum = transbordoGondolas.length + 1;
                     const newId = `Transbordo Excedente ${nextNum}`;
                     foundTransbordo = {
                       id: newId,
                       capacity: 5530,
                       historical: historicalState[newId] || 0,
                       current: 0,
                       used: (historicalState[newId] || 0) + (reservations[newId] || 0),
                       reserved: reservations[newId] || 0,
                       isSpecial: true,
                       isTemporary: true
                     };
                     tempGondolas.push(foundTransbordo);
                   }
                   modGondola = foundTransbordo;
                 }
                modGondola.used += mod.space;
                modGondola.current += mod.space;
                mod.pieces.forEach(p => { currentAllocation[p.displayId] = modGondola.id; });
              }
            }
          }
        }

        setAllocation(currentAllocation);
        setGondolas(tempGondolas);

        setLoading(false);
        
        if (inputRef.current) inputRef.current.focus();
      },
      error: (error) => {
        console.error("Erro ao carregar planilha:", error);
        setErrorMsg("Falha ao carregar a planilha do projeto.");
        setLoading(false);
      }
    });
  };

  useEffect(() => {
    carregarDadosProjeto();
  }, [suspendedProjects, historicalState]);

  // --- CAPTURA GLOBAL DA PISTOLA USB ---
  useEffect(() => {
    let barcodeBuffer = '';
    let timeoutId = null;

    const handleKeyDown = (e) => {
      // Ignorar se o usuário estiver digitando em outro input que não seja a tela inteira
      if (e.target.tagName === 'INPUT' && e.target.className !== 'hidden-input') return;

      if (e.key === 'Enter') {
        if (barcodeBuffer.length > 0) {
          processBarcode(barcodeBuffer.trim().toUpperCase());
          barcodeBuffer = '';
        }
      } else {
        // Ignorar teclas de controle (Shift, Ctrl, etc)
        if (e.key.length === 1) {
          barcodeBuffer += e.key;
          // Limpa o buffer se demorar muito (uma pessoa digitando é lenta, a pistola é rápida)
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => { barcodeBuffer = ''; }, 100);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [projectPieces, allocation, scannedPieces]);

  const processBarcode = (code) => {
    setErrorMsg('');
    if (!code) return;

    // O usuário solicitou ignorar especificamente os 3 primeiros zeros
    let searchCode = code;
    if (code.startsWith('000')) {
      searchCode = code.substring(3);
    }

    // Se o usuário tentar bipar códigos ignorados/inválidos
    if (searchCode === 'SEM_CODIGO' || /[a-zA-Z]/.test(searchCode)) {
      setErrorMsg(`O código ${code} é inválido ou contém letras. Por favor, bipe o código de barras numérico válido (o código de cima na etiqueta).`);
      setLastScanned(null);
      return;
    }

    const peca = projectPieces.find(p => p.id1 === searchCode || p.id2 === searchCode || p.id1 === code || p.id2 === code);
    
    if (!peca) {
      setErrorMsg(`O código ${searchCode} não foi encontrado na planilha deste projeto! (Lido originalmente como ${code})`);
      setLastScanned(null);
      return;
    }

    if (scannedPieces.includes(peca.displayId)) {
      setErrorMsg(`A peça ${code} já foi separada!`);
      setLastScanned(null);
      return;
    }

    const targetGondola = allocation[peca.displayId];
    setScannedPieces(prev => [...prev, peca.displayId]);
    setLastScanned({ peca, gondolaId: targetGondola });
  };

  const handleScan = (e) => {
    e.preventDefault();
    setReportingDefect(false);
    setDefectReason('');

    processBarcode(barcodeInput);
    setBarcodeInput('');
  };

  const handleRejectPiece = () => {
    if (!lastScanned || defectReason.trim() === '') return;
    
    // Retira do array de peças bipadas (o que também libera espaço da gôndola magicamente, pois a gôndola calcula com base no scannedPieces)
    setScannedPieces(prev => prev.filter(id => id !== lastScanned.peca.displayId));
    
    // Adiciona na lista de rejeitados
    setRejectedPieces(prev => [...prev, { peca: lastScanned.peca, reason: defectReason }]);
    
    // Limpa a tela
    setLastScanned(null);
    setReportingDefect(false);
    setDefectReason('');
  };

  const buildReportData = () => {
    const moduleMap = {};
    const noBarcodes = [];
    const defects = rejectedPieces.map(r => ({
      ambiente: r.peca.ambiente,
      nome: r.peca.nome,
      codigo: r.peca.displayId,
      motivo: r.reason
    }));

    projectPieces.forEach(p => {
      const isSemCodigo = p.displayId === 'SEM_CODIGO';
      const isRejected = rejectedPieces.some(r => r.peca.displayId === p.displayId);
      const isScanned = scannedPieces.includes(p.displayId);
      
      if (isSemCodigo) {
        noBarcodes.push({ ambiente: p.ambiente, modulo: p.modulo, nome: p.nome });
      }

      if (!moduleMap[p.moduloId]) {
        moduleMap[p.moduloId] = {
          ambiente: p.ambiente,
          nome: p.modulo,
          total: 0,
          bipadas: 0,
          hasSemCodigo: false,
          hasRecusadas: false
        };
      }
      
      moduleMap[p.moduloId].total++;
      if (isScanned) moduleMap[p.moduloId].bipadas++;
      if (isSemCodigo) moduleMap[p.moduloId].hasSemCodigo = true;
      if (isRejected) moduleMap[p.moduloId].hasRecusadas = true;
    });

    const modulesList = Object.values(moduleMap).map(m => {
      let status = m.bipadas === m.total ? '✅ Completo' : '❌ Incompleto';
      let alertas = [];
      if (m.hasSemCodigo) alertas.push('Tem Peças Sem Código');
      if (m.hasRecusadas) alertas.push('Tem Peças Recusadas');
      return {
        ...m,
        status,
        alertas: alertas.length > 0 ? alertas.join(' / ') : 'Nenhum'
      };
    });

    // Reorganizar os módulos conforme solicitado pelo usuário:
    // Peças recusadas primeiro, seguidas pelas sem código, seguidas do resumo geral
    modulesList.sort((a, b) => {
      const aRec = a.hasRecusadas ? 1 : 0;
      const bRec = b.hasRecusadas ? 1 : 0;
      if (aRec !== bRec) return bRec - aRec; // recusadas primeiro

      const aSem = a.hasSemCodigo ? 1 : 0;
      const bSem = b.hasSemCodigo ? 1 : 0;
      if (aSem !== bSem) return bSem - aSem; // sem código em segundo

      // Se empatar, ordena por ambiente e depois por nome
      if (a.ambiente !== b.ambiente) return a.ambiente.localeCompare(b.ambiente);
      return a.nome.localeCompare(b.nome);
    });

    // Calcular estatísticas para o gráfico
    const scannedCount = scannedPieces.length;
    const defectiveCount = rejectedPieces.length;
    const noBarcodeCount = projectPieces.filter(p => p.displayId === 'SEM_CODIGO').length;
    const pendingCount = projectPieces.filter(p => 
      p.displayId !== 'SEM_CODIGO' && 
      !scannedPieces.includes(p.displayId) && 
      !rejectedPieces.some(r => r.peca.displayId === p.displayId)
    ).length;

    const stats = {
      scanned: scannedCount,
      pending: pendingCount,
      defective: defectiveCount,
      noBarcode: noBarcodeCount
    };

    // Agrupar gôndolas para exportar
    const gondolaGroups = {};
    for (const envName in environments) {
      for (const modId in environments[envName]) {
        const mod = environments[envName][modId];
        if (!mod.pieces || mod.pieces.length === 0) continue;
        
        const firstPiece = mod.pieces[0];
        const gondolaId = allocation[firstPiece.displayId];
        if (!gondolaId) continue;

        const minDims = mod.pieces.map(p => Math.min(p.comprimento, p.largura));
        const maxWidth = Math.max(...minDims);
        const space = maxWidth + SPACING; // SPACING é 80

        if (!gondolaGroups[gondolaId]) {
          gondolaGroups[gondolaId] = {
            gondolaId: gondolaId,
            envs: new Set(),
            modules: []
          };
        }
        gondolaGroups[gondolaId].envs.add(envName);
        
        // Evitar duplicar o mesmo módulo ID na mesma gôndola se vier de múltiplas iterações
        const exists = gondolaGroups[gondolaId].modules.some(m => m.modId === modId);
        if (!exists) {
          gondolaGroups[gondolaId].modules.push({
            modId: modId,
            space: space,
            pieceCount: mod.pieces.length
          });
        }
      }
    }

    const gondolasExport = Object.values(gondolaGroups).map(g => ({
      gondolaId: g.gondolaId,
      environments: Array.from(g.envs).join(', '),
      modules: g.modules.map(m => ({
        modId: m.modId,
        space: m.space,
        pieceCount: m.pieceCount
      }))
    }));

    return { modules: modulesList, noBarcodes, defects, stats, gondolasExport };
  };

  const handleAtualizarPlanilha = async () => {
    setIsUpdatingReport(true);
    
    // Abrir uma janela em branco imediatamente para evitar que o navegador bloqueie o pop-up (bloqueador de anúncios/popups)
    const newWindow = window.open('about:blank', '_blank');
    if (newWindow) {
      newWindow.document.write(`
        <html>
          <head>
            <title>Gerando Planilha...</title>
            <style>
              body {
                background: #121214;
                color: #e1e1e6;
                font-family: system-ui, -apple-system, sans-serif;
                display: flex;
                flex-direction: column;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
              }
              .spinner {
                border: 4px solid rgba(255,255,255,0.1);
                width: 50px;
                height: 50px;
                border-radius: 50%;
                border-left-color: #2563eb;
                animation: spin 1s linear infinite;
                margin-bottom: 20px;
              }
              @keyframes spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
              }
              h2 { font-weight: 500; font-size: 1.25rem; margin: 0; }
              p { color: #8f9099; font-size: 0.9rem; margin-top: 8px; }
            </style>
          </head>
          <body>
            <div class="spinner"></div>
            <h2>Gerando relatório no Google Sheets...</h2>
            <p>Por favor, aguarde alguns segundos.</p>
          </body>
        </html>
      `);
    }

    try {
      const reportData = buildReportData();
      const payload = {
        clientName: currentClient,
        modules: reportData.modules,
        noBarcodes: reportData.noBarcodes,
        defects: reportData.defects,
        stats: reportData.stats,
        gondolasExport: reportData.gondolasExport
      };
      
      const res = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      
      if (data.success) {
        if (newWindow) {
          newWindow.location.href = data.sheetUrl;
        } else {
          // Se o pop-up foi bloqueado por algum motivo extremo, redireciona na mesma aba
          window.open(data.sheetUrl, '_blank');
        }
      } else {
        if (newWindow) newWindow.close();
        alert("Erro no robô do Google: " + data.error);
      }
    } catch (e) {
      if (newWindow) newWindow.close();
      alert("Erro de conexão ao enviar relatório: " + e.message);
    }
    setIsUpdatingReport(false);
  };

  const handleSavePlanilhas = () => {
    const newHistory = { ...historicalState };
    gondolas.forEach(g => {
      const extra = gondolaExtraSpaces[g.id] || 0;
      newHistory[g.id] = g.historical + extra; 
    });
    setHistoricalState(newHistory);
    localStorage.setItem('gondolaHistory', JSON.stringify(newHistory));
    
    setGondolaExtraSpaces({});
    alert("Estoque salvo com sucesso! O espaço adicional foi consolidado no histórico.");
  };

  const handleZerarFabrica = () => {
    setHistoricalState({});
    localStorage.removeItem('gondolaHistory');
    setShowZerarModal(false);
    setGondolaExtraSpaces({}); // Limpar espaços adicionais
    
    setGondolas(prev => prev.map(g => ({
      ...g,
      historical: 0,
      used: g.current
    })));
  };

  const handleEsvaziar = (gondolaId, tipo) => {
    const newHistory = { ...historicalState };
    const currentHist = newHistory[gondolaId] || 0;
    
    if (tipo === 'metade') {
      newHistory[gondolaId] = Math.max(0, currentHist / 2);
    } else {
      newHistory[gondolaId] = 0;
      // Limpa o espaço adicional desta gôndola se esvaziar tudo
      setGondolaExtraSpaces(prev => {
        const next = { ...prev };
        delete next[gondolaId];
        return next;
      });
    }
    
    setHistoricalState(newHistory);
    localStorage.setItem('gondolaHistory', JSON.stringify(newHistory));
    
  };

  const handleSuspendCurrentProject = () => {
    if (!currentClient || currentClient === 'Cliente Desconhecido' || projectPieces.length === 0) {
      alert("Não há nenhum projeto ativo para suspender.");
      return;
    }
    
    requestPassword("1234", "Senha do Operador.", () => {
      const newProj = {
        clientName: currentClient,
        pieces: projectPieces,
        environments: environments,
        scannedPieces: scannedPieces,
        rejectedPieces: rejectedPieces,
        allocation: allocation,
        extraSpaces: gondolaExtraSpaces,
        timestamp: Date.now()
      };
      
      const filtered = suspendedProjects.filter(p => p.clientName !== currentClient);
      const newList = [...filtered, newProj];
      
      setSuspendedProjects(newList);
      localStorage.setItem('suspendedProjects', JSON.stringify(newList));
      
      // Limpar sessão ativa
      const oldClient = currentClient;
      setCurrentClient('Cliente Desconhecido');
      setProjectPieces([]);
      setEnvironments({});
      setScannedPieces([]);
      setRejectedPieces([]);
      setAllocation({});
      setGondolaExtraSpaces({});
      setLastScanned(null);
      
      alert(`Projeto de "${oldClient}" suspenso com sucesso e espaço reservado nas gôndolas!`);
    });
  };

  const handleCompleteCurrentProject = async () => {
    if (!currentClient || currentClient === 'Cliente Desconhecido' || projectPieces.length === 0) {
      alert("Não há nenhum projeto ativo para concluir.");
      return;
    }
    
    requestPassword("1234", "Senha do Operador.", async () => {
      setIsUpdatingReport(true);
      
      // Abrir aba de carregamento imediatamente
      const newWindow = window.open('about:blank', '_blank');
      if (newWindow) {
        newWindow.document.write(`
          <html>
            <head>
              <title>Concluindo Projeto...</title>
              <style>
                body { background: #121214; color: #e1e1e6; font-family: system-ui, -apple-system, sans-serif; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .spinner { border: 4px solid rgba(255,255,255,0.1); width: 50px; height: 50px; border-radius: 50%; border-left-color: #2563eb; animation: spin 1s linear infinite; margin-bottom: 20px; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                h2 { font-weight: 500; font-size: 1.25rem; margin: 0; }
                p { color: #8f9099; font-size: 0.9rem; margin-top: 8px; }
              </style>
            </head>
            <body>
              <div class="spinner"></div>
              <h2>Salvando estoque e finalizando no Google Sheets...</h2>
              <p>Por favor, aguarde.</p>
            </body>
          </html>
        `);
      }

      try {
        const reportData = buildReportData();
        const payload = {
          clientName: currentClient,
          modules: reportData.modules,
          noBarcodes: reportData.noBarcodes,
          defects: reportData.defects,
          stats: reportData.stats,
          gondolasExport: reportData.gondolasExport
        };
        
        const res = await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/plain;charset=utf-8'
          },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (data.success) {
          if (newWindow) {
            newWindow.location.href = data.sheetUrl;
          } else {
            window.open(data.sheetUrl, '_blank');
          }
          
          // Salvar o estoque concluído no histórico
          const newHistory = { ...historicalState };
          gondolas.forEach(g => {
            const extra = gondolaExtraSpaces[g.id] || 0;
            newHistory[g.id] = (historicalState[g.id] || 0) + g.current + extra;
          });
          setHistoricalState(newHistory);
          localStorage.setItem('gondolaHistory', JSON.stringify(newHistory));
          
          // Remover da lista de suspensos (caso estivesse lá)
          const newList = suspendedProjects.filter(p => p.clientName !== currentClient);
          setSuspendedProjects(newList);
          localStorage.setItem('suspendedProjects', JSON.stringify(newList));

          // Limpar sessão ativa
          const oldClient = currentClient;
          setCurrentClient('Cliente Desconhecido');
          setProjectPieces([]);
          setEnvironments({});
          setScannedPieces([]);
          setRejectedPieces([]);
          setAllocation({});
          setGondolaExtraSpaces({});
          setLastScanned(null);
          
          alert(`Projeto de "${oldClient}" concluído com sucesso e planilha gerencial atualizada!`);
        } else {
          if (newWindow) newWindow.close();
          alert("Erro no robô do Google: " + data.error);
        }
      } catch (e) {
        if (newWindow) newWindow.close();
        alert("Erro de conexão ao enviar relatório: " + e.message);
      }
      setIsUpdatingReport(false);
    });
  };

  const handleResumeProject = (name) => {
    if (currentClient && currentClient !== 'Cliente Desconhecido' && projectPieces.length > 0) {
      alert("Por favor, suspenda ou conclua o projeto ativo atual antes de retomar outro!");
      return;
    }
    
    const found = suspendedProjects.find(p => p.clientName === name);
    if (!found) return;
    
    // Restaurar progresso exato
    setCurrentClient(found.clientName);
    setProjectPieces(found.pieces);
    setEnvironments(found.environments);
    setScannedPieces(found.scannedPieces);
    setRejectedPieces(found.rejectedPieces);
    setAllocation(found.allocation);
    setGondolaExtraSpaces(found.extraSpaces || {});
    
    // Remover da lista de suspensos
    const newList = suspendedProjects.filter(p => p.clientName !== name);
    setSuspendedProjects(newList);
    localStorage.setItem('suspendedProjects', JSON.stringify(newList));
    
    alert(`Projeto de "${name}" retomado de onde você parou!`);
  };

  const handleDiscardSuspendedProject = (name) => {
    requestPassword("1234", "Senha do Operador.", () => {
      const newList = suspendedProjects.filter(p => p.clientName !== name);
      setSuspendedProjects(newList);
      localStorage.setItem('suspendedProjects', JSON.stringify(newList));
      alert(`Projeto de "${name}" descartado e espaço de gôndola liberado.`);
    });
  };

  const pendingPieces = projectPieces.filter(p => !scannedPieces.includes(p.displayId));
  const scannablePending = pendingPieces.filter(p => p.displayId !== 'SEM_CODIGO');
  const unscannablePending = pendingPieces.filter(p => p.displayId === 'SEM_CODIGO');

  if (loading) {
    return (
      <div className="app-container" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flexDirection: 'column' }}>
        <Loader2 size={64} color="var(--primary)" className="animate-spin" style={{ animation: 'spin 2s linear infinite' }} />
        <h2 style={{ marginTop: '1rem' }}>Sincronizando Módulos do Google Sheets...</h2>
      </div>
    );
  }

  return (
    <div className="app-wrapper">
      {showZerarModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}>
          <div style={{ background: 'var(--gondola-bg)', padding: '2rem', borderRadius: '1rem', border: '1px solid var(--error)', maxWidth: '450px', textAlign: 'center', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
            <h2 style={{ color: 'var(--error)', marginBottom: '1rem', fontSize: '1.5rem' }}>⚠️ Tem certeza?</h2>
            <p style={{ color: 'var(--text-main)', marginBottom: '2rem', lineHeight: '1.5' }}>
              Isso irá apagar <b>toda a memória</b> de espaços históricos de TODAS as gôndolas. Só faça isso se a fábrica inteira estiver realmente vazia e sem projetos passados. <br/><br/>Essa ação não pode ser desfeita.
            </p>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button onClick={() => setShowZerarModal(false)} style={{ flex: 1, padding: '0.75rem', borderRadius: '0.5rem', background: 'var(--text-muted)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                Não, Cancelar
              </button>
              <button onClick={handleZerarFabrica} style={{ flex: 1, padding: '0.75rem', borderRadius: '0.5rem', background: 'var(--error)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
                Sim, Zerar Tudo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <header className="app-header" style={{ background: 'var(--gondola-bg)', padding: '1rem', borderBottom: '1px solid var(--gondola-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-soft)' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Box size={24} />
          Painel de Separação Inteligente
          <button 
            onClick={carregarDadosProjeto} 
            disabled={loading} 
            title="Recarregar dados da planilha do Google Sheets"
            style={{
              marginLeft: '1.25rem',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              background: '#34495e',
              color: 'white',
              padding: '0.4rem 0.8rem',
              borderRadius: '0.5rem',
              border: 'none',
              cursor: loading ? 'not-allowed' : 'pointer',
              fontWeight: 'bold',
              fontSize: '0.75rem',
              transition: 'all 0.2s ease',
              opacity: loading ? 0.7 : 1,
              boxShadow: '0 2px 4px rgba(0,0,0,0.15)'
            }}
            onMouseOver={(e) => { if (!loading) e.currentTarget.style.background = '#2c3e50'; }}
            onMouseOut={(e) => { if (!loading) e.currentTarget.style.background = '#34495e'; }}
          >
            {loading ? <Loader2 size={12} style={{ animation: 'spin 2s linear infinite' }} /> : '🔄'} Recarregar Projeto
          </button>
        </h1>
        <div style={{ display: 'flex', gap: '2.5rem', alignItems: 'center' }}>
          
          {/* PAINEL DO SUPERVISOR / ENGENHARIA (Ações de Controle e Admin) */}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', background: 'rgba(255, 255, 255, 0.03)', padding: '0.25rem 0.5rem', borderRadius: '0.75rem', border: '1px dashed var(--gondola-border)' }}>
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 'bold', padding: '0 0.25rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>ENG</span>
            <button onClick={() => {
                requestPassword("753951", "Senha do Administrador de Engenharia", handleSavePlanilhas);
              }} style={{ 
                display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#9b59b6', color: 'white', padding: '0.4rem 0.8rem', borderRadius: '0.5rem', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.8rem' 
              }}>
              💾 Salvar Estoque
            </button>
            <button onClick={() => {
                requestPassword("753951", "Senha do Administrador de Engenharia", () => {
                  setScannedPieces([]); setLastScanned(null); setRejectedPieces([]);
                });
              }} style={{
                background: 'rgba(255, 255, 255, 0.08)', color: 'var(--text-main)', padding: '0.4rem 0.8rem', borderRadius: '0.5rem', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.8rem'
              }}>
              🔁 Resetar Bipagem
            </button>
            <button onClick={() => {
                requestPassword("753951", "Senha do Administrador de Engenharia", () => {
                  setShowZerarModal(true);
                });
              }} style={{
                background: 'var(--error)', color: 'white', padding: '0.4rem 0.8rem', borderRadius: '0.5rem', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem'
              }}>
              <AlertTriangle size={12} /> Zerar Fábrica
            </button>
          </div>

          {/* DIVISOR VERTICAL NITÍDO */}
          <div style={{ width: '2px', height: '24px', background: 'var(--gondola-border)', opacity: 0.6 }} />

          {/* FLUXO DE TRABALHO DO OPERADOR (Ações Diárias Cronológicas) */}
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <button onClick={handleAtualizarPlanilha} disabled={isUpdatingReport} style={{ 
                display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'var(--primary)', color: 'white', padding: '0.5rem 1.25rem', borderRadius: '9999px', border: 'none', cursor: isUpdatingReport ? 'not-allowed' : 'pointer', fontWeight: 'bold', opacity: isUpdatingReport ? 0.7 : 1, fontSize: '0.85rem' 
              }}>
              {isUpdatingReport ? 'Carregando...' : '📊 Enviar Relatório'}
            </button>
            <button onClick={handleSuspendCurrentProject} style={{ 
                display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#e67e22', color: 'white', padding: '0.5rem 1.25rem', borderRadius: '9999px', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem' 
              }}>
              ⏸️ Suspender Projeto
            </button>
            <button onClick={handleCompleteCurrentProject} style={{ 
                display: 'flex', alignItems: 'center', gap: '0.4rem', background: '#27ae60', color: 'white', padding: '0.5rem 1.5rem', borderRadius: '9999px', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.9rem', boxShadow: '0 0 12px rgba(39, 174, 96, 0.4)' 
              }}>
              ✅ Concluir Projeto
            </button>
          </div>
          
        </div>
      </header>

      {/* 3 COLUNAS */}
      <div className="app-container" style={{ display: 'grid', gridTemplateColumns: '1fr 1.2fr 350px', gap: '1rem', padding: '1rem', height: 'calc(100vh - 80px)', alignItems: 'stretch' }}>
        
        {/* COLUNA 1: PENDENTES & SCANNER */}
        <div className="dashboard-card" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: 'var(--primary)' }}>
            <List size={24} />
            Falta Separar ({scannablePending.length})
          </h2>

          <div style={{ background: 'var(--gondola-bg)', padding: '1.5rem', borderRadius: '1rem', marginBottom: '1rem', boxShadow: 'var(--shadow-soft)' }}>
            <p style={{ marginBottom: '0.5rem', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Entrada de Código (Pistola ou Teclado):</p>
            <form onSubmit={handleScan} style={{ width: '100%' }}>
              <input
                ref={inputRef}
                type="text"
                placeholder="Bipe aqui..."
                value={barcodeInput}
                onChange={(e) => setBarcodeInput(e.target.value)}
                autoFocus
                autoComplete="off"
                style={{
                  width: '100%', padding: '1rem', borderRadius: '9999px', border: '2px solid var(--gondola-border)', 
                  background: 'var(--bg-color)', color: 'var(--text-main)', fontSize: '1.1rem', outline: 'none'
                }}
              />
            </form>
            {errorMsg && <div style={{ color: '#f87171', marginTop: '0.5rem', fontSize: '0.85rem' }}>{errorMsg}</div>}
          </div>

          {lastScanned && (
            <div style={{ marginBottom: '1rem', background: 'rgba(34, 197, 94, 0.1)', border: '1px solid var(--success)', padding: '0.75rem 1rem', borderRadius: '0.75rem' }}>
              
              <div style={{ color: 'var(--text-main)', fontWeight: 'bold', fontSize: '1.1rem', textAlign: 'center', marginBottom: '0.5rem' }}>
                ID: {lastScanned.peca.displayId}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ background: 'var(--success)', color: 'white', fontWeight: 'bold', padding: '0.4rem 1rem', borderRadius: '0.5rem', fontSize: '1.3rem', boxShadow: '0 0 10px var(--success-glow)', flex: 1, textAlign: 'center', marginRight: '0.5rem' }}>
                  Gôndola {lastScanned.gondolaId}
                </div>
                {!reportingDefect && (
                  <button onClick={() => setReportingDefect(true)} style={{ background: 'var(--error)', color: 'white', padding: '0.3rem 0.6rem', borderRadius: '0.5rem', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.75rem', boxShadow: '0 0 10px var(--accent-glow)', flexShrink: 0, textAlign: 'center', lineHeight: '1.2' }}>
                    Informar<br/>Defeito
                  </button>
                )}
              </div>

              {reportingDefect && (
                <div style={{ marginTop: '0.75rem', background: 'var(--bg-color)', padding: '1rem', borderRadius: '0.75rem', border: '1px solid var(--error)', animation: 'popIn 0.3s ease' }}>
                  <label style={{ display: 'block', color: 'var(--error)', fontWeight: 'bold', marginBottom: '0.5rem' }}>Informar motivo da recusa</label>
                  <input 
                    type="text" 
                    value={defectReason} 
                    onChange={e => setDefectReason(e.target.value)} 
                    style={{ width: '100%', padding: '0.75rem', borderRadius: '0.5rem', border: '1px solid var(--gondola-border)', background: 'var(--gondola-bg)', color: 'var(--text-main)', marginBottom: '0.75rem', outline: 'none' }} 
                    placeholder="Ex: Peça arranhada, erro de corte, lascada..." 
                    autoFocus
                  />
                  <button 
                    onClick={handleRejectPiece} 
                    disabled={defectReason.trim() === ''} 
                    style={{ width: '100%', background: defectReason.trim() === '' ? 'var(--text-muted)' : 'var(--error)', color: 'white', padding: '0.75rem', borderRadius: '9999px', border: 'none', fontWeight: 'bold', cursor: defectReason.trim() === '' ? 'not-allowed' : 'pointer', transition: 'background 0.3s' }}
                  >
                    Encaminhar relatório
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="pieces-list" style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid var(--gondola-border)', paddingTop: '1rem' }}>
            {scannablePending.map(p => (
              <div key={p.displayId} style={{ padding: '0.5rem', borderBottom: '1px solid var(--gondola-border)', fontSize: '0.8rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>[{p.displayId}]</span> <br/>
                {p.nome} <span style={{ opacity: 0.5 }}>({p.comprimento}mm)</span>
              </div>
            ))}
          </div>

          {unscannablePending.length > 0 && (
            <>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', margin: '1.5rem 0 1rem 0', color: 'var(--error)' }}>
                <AlertTriangle size={24} />
                Sem Código de Barras ({unscannablePending.length})
              </h2>
              <div className="pieces-list" style={{ maxHeight: '30vh', overflowY: 'auto', borderTop: '1px solid var(--gondola-border)', paddingTop: '1rem' }}>
                {unscannablePending.map((p, idx) => (
                  <div key={`unscan-${idx}`} style={{ padding: '0.5rem', borderBottom: '1px solid var(--gondola-border)', fontSize: '0.8rem' }}>
                    <span style={{ color: 'var(--error)', fontWeight: 'bold' }}>(Item sem código de barras)</span> <br/>
                    {p.nome} <span style={{ opacity: 0.5 }}>({p.comprimento}mm)</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {rejectedPieces.length > 0 && (
            <div style={{ marginTop: '2rem' }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: 'var(--error)', fontSize: '1.1rem' }}>
                <AlertTriangle size={24} />
                Peças Recusadas ({rejectedPieces.length})
              </h2>
              <div className="pieces-list" style={{ maxHeight: '30vh', overflowY: 'auto', borderTop: '1px solid var(--gondola-border)', paddingTop: '1rem' }}>
                {rejectedPieces.map((r, idx) => (
                  <div key={`reject-${idx}`} style={{ padding: '0.75rem', borderBottom: '1px solid var(--gondola-border)', fontSize: '0.8rem', background: 'rgba(248, 49, 70, 0.05)', borderRadius: '0.5rem', marginBottom: '0.5rem' }}>
                    <span style={{ color: 'var(--error)', fontWeight: 'bold' }}>Motivo: {r.reason}</span> <br/>
                    {r.peca.nome} <span style={{ opacity: 0.5 }}>({r.peca.comprimento}mm)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* COLUNA 2: PROJETO SEPARADO (A ÁRVORE) */}
        <div className="dashboard-card" style={{ height: '100%', overflowY: 'auto' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem', color: 'var(--success)' }}>
            <Check size={24} />
            Projeto Separado ({scannedPieces.length})
          </h2>

          {Object.keys(environments).map(env => (
            <div key={env} style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ borderBottom: '2px solid var(--primary)', paddingBottom: '0.5rem', marginBottom: '1rem', color: 'var(--text-main)' }}>
                {env.toUpperCase()}
              </h3>
              
              {Object.keys(environments[env]).map(modId => {
                const modulo = environments[env][modId];
                // Pegar APENAS as peças deste módulo que JÁ FORAM bipadas
                const pecasSeparadas = modulo.pieces.filter(p => scannedPieces.includes(p.displayId));
                const total = modulo.pieces.length;
                const isComplete = pecasSeparadas.length === total;
                const hasRejected = rejectedPieces.some(r => r.peca.moduloId === modId && r.peca.ambiente === env);
                const hasUnscannable = modulo.pieces.some(p => p.displayId === 'SEM_CODIGO');

                // Esqueleto visual: sempre mostra o Módulo, mas as peças só aparecem quando bipadas
                return (
                  <div key={modId} style={{ padding: '0.75rem', background: isComplete ? 'rgba(34, 197, 94, 0.1)' : 'var(--gondola-bg)', borderRadius: '0.75rem', marginBottom: '0.5rem', border: isComplete ? '1px solid var(--success)' : '1px solid var(--gondola-border)', borderLeft: isComplete ? '4px solid var(--success)' : (hasRejected ? '4px solid var(--error)' : '4px solid var(--text-muted)') }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ fontSize: '0.85rem', flex: 1, paddingRight: '0.5rem', fontWeight: 'bold' }}>
                        <div style={{ marginBottom: (hasRejected || hasUnscannable) ? '0.5rem' : '0' }}>
                          <span style={{ color: 'var(--text-muted)' }}>Mód {modId}: </span>
                          {modulo.nome}
                        </div>
                        {(hasRejected || hasUnscannable) && (
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {hasRejected && <span style={{ color: 'var(--error)', fontSize: '0.7rem', background: 'rgba(248, 49, 70, 0.1)', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>Filhos Recusados</span>}
                            {hasUnscannable && <span style={{ color: 'var(--warning)', fontSize: '0.7rem', background: 'rgba(245, 158, 11, 0.1)', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>Filhos sem código</span>}
                          </div>
                        )}
                      </div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 'bold', color: isComplete ? 'var(--success)' : 'var(--text-main)' }}>
                        {pecasSeparadas.length}/{total}
                      </div>
                    </div>

                    <div style={{ marginTop: '0.5rem', paddingLeft: '0.5rem', borderLeft: '1px dashed var(--gondola-border)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {pecasSeparadas.length === 0 ? (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                          Nenhuma peça separada ainda...
                        </div>
                      ) : (
                        pecasSeparadas.map(p => (
                          <div key={p.displayId} style={{ 
                            fontSize: '0.75rem', color: 'var(--success)', display: 'flex', alignItems: 'flex-start', gap: '0.3rem'
                          }}>
                            <span style={{ marginTop: '2px' }}><Check size={12}/></span>
                            <span>[{p.displayId}] {p.nome}</span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* COLUNA 3: GÔNDOLAS */}
        <div className="dashboard-card" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', color: 'var(--primary)' }}>
            <Box size={24} />
            Alocação de Gôndolas
          </h2>

          {/* Legenda de Cores */}
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ width: '8px', height: '8px', background: 'var(--text-muted)', borderRadius: '2px' }} /> Histórico
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ width: '8px', height: '8px', background: 'repeating-linear-gradient(45deg, #2980b9, #2980b9 2px, #34495e 2px, #34495e 4px)', borderRadius: '2px' }} /> Reservado (Pausado)
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ width: '8px', height: '8px', background: 'var(--primary)', borderRadius: '2px' }} /> Atual
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ width: '8px', height: '8px', background: '#9b59b6', borderRadius: '2px' }} /> Extra (+)
            </div>
          </div>

          {gondolas.some(g => g.id.startsWith('Transbordo Excedente') && (g.used + (gondolaExtraSpaces[g.id] || 0)) > 0) && (
            <div style={{
              background: 'rgba(230, 126, 34, 0.1)',
              border: '1px solid #e67e22',
              color: '#e67e22',
              padding: '0.75rem 1rem',
              borderRadius: '0.75rem',
              marginBottom: '1rem',
              fontSize: '0.8rem',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '0.5rem',
              lineHeight: '1.4'
            }}>
              <AlertCircle size={18} style={{ flexShrink: 0, marginTop: '2px' }} />
              <div>
                <strong>Atenção: Transbordo de Produção!</strong><br />
                O projeto atual excedeu a capacidade das gôndolas padrão. Gôndolas de <strong>Transbordo Excedente</strong> foram geradas.
              </div>
            </div>
          )}
          
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '1rem', paddingRight: '0.25rem', marginBottom: '0.5rem' }}>
            {gondolas.map(g => {
              const extraSpace = gondolaExtraSpaces[g.id] || 0;
              const totalUsed = g.used + extraSpace;
              
              if (g.id.startsWith('Transbordo Excedente') && totalUsed === 0 && g.current === 0 && g.historical === 0) {
                return null;
              }
              
              const resSpace = g.reserved || 0;
              const percHist = Math.min(100, (g.historical / g.capacity) * 100);
              const percReserved = Math.min(100 - percHist, (resSpace / g.capacity) * 100);
              const percCurr = Math.min(100 - percHist - percReserved, (g.current / g.capacity) * 100);
              const percExtra = Math.min(100 - percHist - percReserved - percCurr, (extraSpace / g.capacity) * 100);
              const isOverfull = totalUsed > g.capacity;
              
              return (
                <div key={g.id} style={{ background: 'var(--gondola-bg)', padding: '1.25rem', borderRadius: '1rem', border: '1px solid var(--gondola-border)', borderTop: isOverfull ? '4px solid var(--error)' : (g.id.startsWith('Transbordo Excedente') ? '4px solid #e67e22' : '4px solid var(--primary)'), boxShadow: 'var(--shadow-soft)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span>{g.isSpecial && !g.id.startsWith('Transbordo Excedente') ? '' : (g.id.startsWith('Transbordo Excedente') ? '' : 'Gôndola ')}{g.id}</span>
                      {g.id.startsWith('Transbordo Excedente') && (
                        <span style={{ fontSize: '0.75rem', background: '#e67e22', color: 'white', padding: '0.2rem 0.5rem', borderRadius: '4px', fontWeight: 'bold' }}>
                          Transbordo Excedente
                        </span>
                      )}
                      {isOverfull && g.isSpecial && !g.id.startsWith('Transbordo Excedente') && (
                        <span style={{ fontSize: '0.7rem', background: 'var(--error)', color: 'white', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                          Necessário empilhar ambientes
                        </span>
                      )}
                    </div>
                    <span style={{ color: isOverfull ? 'var(--error)' : 'var(--text-muted)' }}>
                      {(totalUsed/1000).toFixed(2)}m / {(g.capacity/1000).toFixed(2)}m
                    </span>
                  </div>
                  <div style={{ width: '100%', height: '12px', background: 'var(--gondola-border)', borderRadius: '9999px', overflow: 'hidden', display: 'flex' }}>
                    <div style={{ width: `${percHist}%`, height: '100%', background: 'var(--text-muted)', transition: 'width 0.3s ease' }} title="Espaço Histórico" />
                    <div style={{ width: `${percReserved}%`, height: '100%', background: 'repeating-linear-gradient(45deg, #2980b9, #2980b9 5px, #34495e 5px, #34495e 10px)', transition: 'width 0.3s ease' }} title="Espaço Reservado (Pausado)" />
                    <div style={{ width: `${percCurr}%`, height: '100%', background: isOverfull ? 'var(--error)' : 'var(--primary)', transition: 'width 0.3s ease' }} title="Projeto Atual" />
                    <div style={{ width: `${percExtra}%`, height: '100%', background: '#9b59b6', transition: 'width 0.3s ease' }} title="Espaço Adicional (+)" />
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.75rem' }}>
                    <button onClick={() => {
                      requestPassword("753951", "Senha do Administrador de Engenharia", () => {
                        handleAdicionarEspacoGondola(g.id);
                      });
                    }} style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem', borderRadius: '0.5rem', background: '#9b59b6', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>+</button>
                    <button onClick={() => {
                      requestPassword("1234", "Senha do Operador.", () => {
                        handleEsvaziar(g.id, 'metade');
                      });
                    }} style={{ flex: 1, padding: '0.4rem', fontSize: '0.75rem', borderRadius: '0.5rem', background: 'var(--bg-color)', border: '1px solid var(--text-muted)', color: 'var(--text-main)', cursor: 'pointer', transition: 'background 0.2s' }}>Esvaziar Metade</button>
                    <button onClick={() => {
                      requestPassword("1234", "Senha do Operador.", () => {
                        handleEsvaziar(g.id, 'tudo');
                      });
                    }} style={{ flex: 1, padding: '0.4rem', fontSize: '0.75rem', borderRadius: '0.5rem', background: 'rgba(248, 49, 70, 0.15)', color: 'var(--error)', border: '1px solid var(--error)', cursor: 'pointer', transition: 'opacity 0.2s' }}>Esvaziar Tudo</button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* PAINEL DE PROJETOS SUSPENSOS */}
          {suspendedProjects.length > 0 && (
            <div style={{ borderTop: '1px solid var(--gondola-border)', paddingTop: '0.75rem', marginTop: '0.5rem' }}>
              <h3 style={{ fontSize: '0.9rem', color: 'var(--text-main)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                📌 Projetos Pausados ({suspendedProjects.length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxH: '20vh', overflowY: 'auto' }}>
                {suspendedProjects.map((p, idx) => {
                  const doneCount = p.scannedPieces.length;
                  const totalCount = p.pieces.length;
                  return (
                    <div key={`susp-${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', background: 'var(--gondola-bg)', border: '1px solid var(--gondola-border)', borderRadius: '0.5rem', fontSize: '0.75rem' }}>
                      <div style={{ flex: 1, minWidth: 0, paddingRight: '0.5rem' }}>
                        <div style={{ fontWeight: 'bold', color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.clientName}>
                          {p.clientName}
                        </div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
                          Progresso: {doneCount}/{totalCount} peças
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.25rem' }}>
                        <button onClick={() => handleResumeProject(p.clientName)} style={{ background: 'var(--primary)', color: 'white', border: 'none', padding: '0.25rem 0.5rem', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.7rem' }}>
                          ▶️ Retomar
                        </button>
                        <button onClick={() => handleDiscardSuspendedProject(p.clientName)} style={{ background: 'rgba(248,49,70,0.15)', color: 'var(--error)', border: '1px solid var(--error)', padding: '0.25rem 0.5rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.7rem' }}>
                          🗑️
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

      {/* MODAL DE SENHA CUSTOMIZADO E MASCARADO */}
      {passwordModal.isOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10000 }}>
          <div style={{ background: 'var(--gondola-bg)', padding: '2rem', borderRadius: '1.25rem', border: '1px solid var(--gondola-border)', maxWidth: '400px', width: '90%', textAlign: 'center', boxShadow: '0 10px 25px rgba(0,0,0,0.5)' }}>
            <h3 style={{ color: 'var(--text-main)', marginBottom: '0.75rem', fontSize: '1.2rem', fontWeight: 'bold' }}>🔑 Validação de Segurança</h3>
            <p style={{ color: 'var(--text-muted)', marginBottom: '1.5rem', fontSize: '0.9rem', lineHeight: '1.4' }}>{passwordModal.message}</p>
            <input 
              type="password" 
              value={passwordInputValue} 
              onChange={e => { setPasswordInputValue(e.target.value); setPasswordInputError(false); }}
              style={{ width: '100%', padding: '0.75rem 1rem', borderRadius: '0.75rem', border: passwordInputError ? '2px solid var(--error)' : '2px solid var(--gondola-border)', background: 'var(--bg-color)', color: 'var(--text-main)', fontSize: '1.3rem', outline: 'none', textAlign: 'center', letterSpacing: '0.2em', marginBottom: '1.5rem' }} 
              placeholder="••••••"
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter') handleConfirmPassword();
              }}
            />
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button onClick={() => setPasswordModal({ isOpen: false, expectedPassword: '', message: '', onSuccess: null })} style={{ flex: 1, padding: '0.75rem', borderRadius: '0.75rem', background: 'var(--text-muted)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.9rem' }}>
                Cancelar
              </button>
              <button onClick={handleConfirmPassword} style={{ flex: 1, padding: '0.75rem', borderRadius: '0.75rem', background: 'var(--primary)', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.9rem' }}>
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
  );
}
