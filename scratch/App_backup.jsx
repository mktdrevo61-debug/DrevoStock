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
  
  const inputRef = useRef(null);

  // 1. Carregar Planilha Real e Rodar Motor de Inteligência
  useEffect(() => {
    Papa.parse(GOOGLE_SHEET_CSV_URL, {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        let rawPieces = [];
        const moduleNames = {}; // Mapa para guardar o nome real de cada módulo { id: 'nome' }

        // PASSAGEM 1: Extrair dados brutos e mapear todos os IDs de módulos válidos
        results.data.forEach(row => {
          const moduloId = row["ID do Módulo"] || 'Avulso';
          const moduloNome = row["Descrição do módulo"] || 'Módulo Avulso';
          
          // Sempre salva o nome do módulo para que ele exista na lista de Pais válidos!
          // Isso resolve o problema de pais que só contêm "CRU" sumirem do radar.
          if (!moduleNames[moduloId]) {
            moduleNames[moduloId] = moduloNome;
          }

          let barcodeNum = row["ID no RP / cod de barras"]?.trim() || '';
          let barcodeFuracao = row["Código de Barras / Cod da furação"]?.trim() || '';
          const comp = parseFloat(row["altura"]) || 0;
          const larg = parseFloat(row["largura"]) || 0;
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

        // PASSAGEM 3: Aplicar as Anexações e Agrupar
        const parsedPieces = [];
        const envHierarchy = {};
        const modules = {};

        rawPieces.forEach(peca => {
          const redirectKey = peca.moduloId + '_' + peca.ambiente;
          let finalModuloId = moduleRedirects[redirectKey] || peca.moduloId;

          peca.moduloId = finalModuloId;
          peca.modulo = moduleNames[finalModuloId] || peca.modulo;
          
          parsedPieces.push(peca);

          // Estruturar para o Painel Visual (Agrupado por Ambiente -> Módulo)
          if (!envHierarchy[peca.ambiente]) envHierarchy[peca.ambiente] = {};
          if (!envHierarchy[peca.ambiente][peca.moduloId]) {
            envHierarchy[peca.ambiente][peca.moduloId] = { nome: peca.modulo, pieces: [] };
          }
          envHierarchy[peca.ambiente][peca.moduloId].pieces.push(peca);

          // Agrupar apenas por módulo para o Algoritmo de Gôndolas
          if (!modules[peca.moduloId]) modules[peca.moduloId] = [];
          modules[peca.moduloId].push(peca);
        });

        setProjectPieces(parsedPieces);

        // PASSAGEM 4: Agrupamento Inteligente de Peças Órfãs (Pilhas)
        for (const envName in envHierarchy) {
          const env = envHierarchy[envName];
          const orphanPieces = [];
          const validModules = {};
          
          for (const modId in env) {
            const mod = env[modId];
            if (mod.pieces.length === 1) {
              orphanPieces.push(mod.pieces[0]);
            } else {
              validModules[modId] = mod;
            }
          }
          
          if (orphanPieces.length > 0) {
            
            // Regra Específica: Se o ambiente possui órfãos (está "bagunçado"), desmanchar Tampos 30mm, Fechamentos e Portas
            // mesmo que eles tenham agrupado corretamente (>= 2 peças), para que tudo vá para as pilhas.
            const modsToDismantle = [];
            for (const mId in validModules) {
              const modName = validModules[mId].nome.toUpperCase().trim();
              if (modName.startsWith('TAMPO 30MM') || modName.startsWith('FECHAMENTO EXTERNO') || modName.startsWith('PORTA ')) {
                modsToDismantle.push(mId);
              }
            }
            
            modsToDismantle.forEach(mId => {
              const modToBreak = validModules[mId];
              orphanPieces.push(...modToBreak.pieces); // Joga todas as peças desse módulo pra lista de órfãos
              delete validModules[mId]; // Remove dos módulos válidos
            });

            // Ordenar órfãs: mais larga primeiro. Se empatar, mais alta (comprimento) primeiro.
            orphanPieces.sort((a, b) => {
              if (b.largura !== a.largura) return b.largura - a.largura;
              return b.comprimento - a.comprimento;
            });
            
            let virtualStackId = 1;
            let pieces = [...orphanPieces];
            
            while (pieces.length > 0) {
              // Iniciar nova pilha
              const basePiece = pieces.shift();
              const stackBaseWidth = basePiece.largura;
              const stack = {
                id: `PILHA_${virtualStackId++}`,
                nome: `Pilha de Peças Órfãs`,
                pieces: [basePiece],
                thickness: basePiece.espessura
              };
              
              // Tentar empilhar as próximas peças enquanto não estourar 300mm
              while (pieces.length > 0) {
                let layerWidth = 0;
                let layerMaxThickness = 0;
                const layerPieces = [];
                const remainingPieces = [];
                
                // Forma 1 camada
                for (const p of pieces) {
                  if (layerWidth + p.largura <= stackBaseWidth) {
                    layerWidth += p.largura;
                    layerMaxThickness = Math.max(layerMaxThickness, p.espessura);
                    layerPieces.push(p);
                  } else {
                    remainingPieces.push(p);
                  }
                }
                
                if (layerPieces.length === 0) break; // Trava de segurança (nunca deve ocorrer devido à ordenação)
                
                if (stack.thickness + layerMaxThickness <= 300) {
                  stack.pieces.push(...layerPieces);
                  stack.thickness += layerMaxThickness;
                  pieces = remainingPieces; // Atualiza fila
                } else {
                  // Estourou os 300mm. Abandona essa pilha e deixa as peças para a próxima
                  break;
                }
              }
              
              // Registra a pilha gerada e atualiza o moduloId das peças para não quebrar a lógica de UI e gôndolas
              validModules[stack.id] = stack;
              stack.pieces.forEach(p => {
                p.moduloId = stack.id;
                p.modulo = stack.nome;
              });
            }
          }
          
          envHierarchy[envName] = validModules;
        }

        setEnvironments(envHierarchy);

        // --- Algoritmo de Transbordo Inteligente (7 Gôndolas, Agrupado por Ambiente) ---
        const GONDOLAS_COUNT = 7;
        const GONDOLA_CAPACITY = 5530;
        const SPACING = 80;

        let tempGondolas = Array.from({length: GONDOLAS_COUNT}, (_, i) => ({
          id: i + 1,
          capacity: GONDOLA_CAPACITY,
          used: SPACING // Cada gôndola começa com 80mm de folga no início
        }));
        
        if (Object.keys(envHierarchy).length > 0) {
          const currentAllocation = {};

          // 1. Estruturar os módulos dentro dos ambientes e calcular o espaço de cada um
          const environmentsList = Object.keys(envHierarchy).map(envName => {
            const modIds = Object.keys(envHierarchy[envName]);
            const modulesList = modIds.map(modId => {
              const mod = envHierarchy[envName][modId];
              
              // Regra da foto: As peças ficam em pé. A largura ocupada no chão da gôndola 
              // é a menor dimensão de cada peça (já que a maior fica pra cima).
              // Pega a maior largura entre todas as peças desse módulo (pai + filhos juntos)
              const minDims = mod.pieces.map(p => Math.min(p.comprimento, p.largura));
              const maxWidth = Math.max(...minDims);
              const totalSpace = maxWidth + SPACING; // Adiciona os 80mm após o conjunto
              
              return {
                modId,
                nome: mod.nome,
                pieces: mod.pieces,
                space: totalSpace
              };
            });
            
            const totalEnvSpace = modulesList.reduce((sum, mod) => sum + mod.space, 0);
            
            return {
              name: envName,
              modules: modulesList,
              totalSpace: totalEnvSpace
            };
          });

          // 2. Ordenar ambientes do maior pro menor para melhorar o encaixe físico (bin packing)
          environmentsList.sort((a, b) => b.totalSpace - a.totalSpace);

          // 3. Alocar na gôndola
          for (const env of environmentsList) {
            // Tentar encontrar uma gôndola que caiba o ambiente INTEIRO
            let targetGondola = tempGondolas.find(g => g.used + env.totalSpace <= g.capacity);
            
            if (targetGondola) {
              // Cabe inteiro na mesma gôndola!
              for (const mod of env.modules) {
                targetGondola.used += mod.space;
                for (const p of mod.pieces) {
                  currentAllocation[p.displayId] = targetGondola.id;
                }
              }
            } else {
              // Não cabe inteiro, temos que quebrar o ambiente em módulos e espalhar
              for (const mod of env.modules) {
                let modGondola = tempGondolas.find(g => g.used + mod.space <= g.capacity);
                
                if (!modGondola) {
                  // Se não couber em NENHUMA gôndola, joga na que estiver mais vazia 
                  // para garantir que o sistema não trave e perca peças.
                  let bestGondola = tempGondolas[0];
                  for (let i = 1; i < tempGondolas.length; i++) {
                    if (tempGondolas[i].used < bestGondola.used) {
                      bestGondola = tempGondolas[i];
                    }
                  }
                  modGondola = bestGondola;
                }
                
                modGondola.used += mod.space;
                for (const p of mod.pieces) {
                  currentAllocation[p.displayId] = modGondola.id;
                }
              }
            }
          }

          setAllocation(currentAllocation);
          setGondolas(tempGondolas);
        }

        setLoading(false);
        
        if (inputRef.current) inputRef.current.focus();
      },
      error: (error) => {
        console.error("Erro ao carregar planilha:", error);
        setErrorMsg("Falha ao carregar a planilha do projeto.");
        setLoading(false);
      }
    });
  }, []);

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

  const exportToCSV = () => {
    // Montar os dados da planilha de separação
    const csvData = projectPieces.map(p => ({
      'Gôndola Alocada': allocation[p.displayId] ? `Gôndola ${allocation[p.displayId]}` : 'Sem Espaço',
      'Ambiente': p.ambiente,
      'PAI (Módulo)': `[Mód ${p.moduloId}] ${p.modulo}`,
      'FILHO (Peça)': `[Cód ${p.displayId}] ${p.nome}`,
      'Comprimento (mm)': p.comprimento,
      'Status de Separação': scannedPieces.includes(p.displayId) ? 'Separado na Gôndola' : 'Aguardando Bipagem'
    }));

    // Ordenar por Gôndola, depois Ambiente, depois Módulo Pai
    csvData.sort((a, b) => {
      if (a['Gôndola Alocada'] !== b['Gôndola Alocada']) return a['Gôndola Alocada'].localeCompare(b['Gôndola Alocada']);
      if (a['Ambiente'] !== b['Ambiente']) return a['Ambiente'].localeCompare(b['Ambiente']);
      return a['PAI (Módulo)'].localeCompare(b['PAI (Módulo)']);
    });

    const csvString = Papa.unparse(csvData);
    const blob = new Blob(["\uFEFF" + csvString], { type: 'text/csv;charset=utf-8;' }); // \uFEFF para Excel ler UTF-8 com acentos
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'Planilha_Separacao_Gondolas.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
      {/* HEADER */}
      <header className="app-header" style={{ background: 'var(--gondola-bg)', padding: '1rem', borderBottom: '1px solid var(--gondola-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', boxShadow: 'var(--shadow-soft)' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Box size={24} />
          Painel de Separação Inteligente
        </h1>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={() => { setScannedPieces([]); setLastScanned(null); setRejectedPieces([]); }} style={{
              background: 'var(--error)', color: 'white', padding: '0.5rem 1rem', borderRadius: '9999px', border: 'none', cursor: 'pointer', fontWeight: 'bold'
            }}>
            🔁 Resetar Tudo
          </button>
          <button onClick={exportToCSV} style={{ 
              display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'var(--success)', color: 'white', padding: '0.5rem 1.5rem', borderRadius: '9999px', border: 'none', cursor: 'pointer', fontWeight: 'bold' 
            }}>
            <Download size={18} /> Planilha
          </button>
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
        <div className="dashboard-card">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem', color: 'var(--primary)' }}>
            <Box size={24} />
            Alocação de Gôndolas
          </h2>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {gondolas.map(g => {
              const perc = Math.min(100, (g.used / g.capacity) * 100);
              const isFull = perc >= 95;
              return (
                <div key={g.id} style={{ background: 'var(--gondola-bg)', padding: '1.25rem', borderRadius: '1rem', border: '1px solid var(--gondola-border)', borderTop: isFull ? '4px solid var(--error)' : '4px solid var(--primary)', boxShadow: 'var(--shadow-soft)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem', fontWeight: 'bold' }}>
                    <span>Gôndola {g.id}</span>
                    <span style={{ color: isFull ? 'var(--error)' : 'var(--text-muted)' }}>
                      {(g.used/1000).toFixed(2)}m / {(g.capacity/1000).toFixed(2)}m
                    </span>
                  </div>
                  <div style={{ width: '100%', height: '8px', background: 'var(--gondola-border)', borderRadius: '9999px', overflow: 'hidden' }}>
                    <div style={{ width: `${perc}%`, height: '100%', background: isFull ? 'var(--error)' : 'var(--primary)', borderRadius: '9999px', transition: 'width 0.3s ease' }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>
    </div>
  );
}
