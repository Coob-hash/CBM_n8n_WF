/* Shared PDF renderer for the local form and the future application. */
(function (root) {
  'use strict';
  async function createReport(data, photoDataUrl, blank = false) {
    const {PDFDocument, StandardFonts, rgb} = root.PDFLib;
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const navy = rgb(.09,.19,.28), ink = rgb(.17,.21,.25), grey = rgb(.40,.45,.49), pale = rgb(.88,.91,.93);
    const width = 595.28, height = 841.89, margin = 44, usable = width - margin * 2;
    let page, y;
    const txt = (v) => String(v == null ? '' : v).replace(/\r\n?/g,'\n').replace(/\t/g,'    ');
    function lines(value, font, size, maxWidth) {
      const out = [];
      for (const para of txt(value).split('\n')) {
        if (!para.trim()) {out.push(''); continue;}
        let line = '';
        for (const word of para.trim().split(/\s+/)) {
          if (font.widthOfTextAtSize(word,size) > maxWidth) {
            if (line) {out.push(line); line = '';}
            for (const char of word) {
              if (font.widthOfTextAtSize(line + char,size) > maxWidth) {out.push(line); line = '';}
              line += char;
            }
          } else if (font.widthOfTextAtSize(line ? line + ' ' + word : word,size) <= maxWidth) {
            line += (line ? ' ' : '') + word;
          } else {out.push(line); line = word;}
        }
        if (line) out.push(line);
      }
      return out;
    }
    function newPage() {
      page = pdf.addPage([width,height]); y = height - margin;
      page.drawText('CBM  /  RAPPORTO TECNICO  /  TECHNICIAN REPORT',{x:margin,y,size:9,font:bold,color:navy});
      y -= 29;
      if (pdf.getPageCount() === 1) {
        page.drawText('Rapporto di intervento',{x:margin,y,size:23,font:bold,color:navy}); y-=20;
        page.drawText('Maintenance intervention report',{x:margin,y,size:12,font:regular,color:grey}); y-=24;
      } else {
        page.drawText('Ticket ' + (data.ticket_id || '________') + '  /  Continua - Continued',{x:margin,y,size:12,font:bold,color:navy});y-=24;
      }
    }
    function ensure(h) {if (y-h < 54) newPage();}
    function paragraph(value, {size=10,font=regular,color=ink,x=margin,maxWidth=usable,leading=14}={}) {
      for (const line of lines(value,font,size,maxWidth)) {
        ensure(leading);if(line)page.drawText(line,{x,y,size,font,color});y-=leading;
      }
    }
    function section(it,en) {
      ensure(57);y-=8;paragraph(it,{font:bold,size:13,color:navy,leading:17});
      paragraph(en,{size:9,color:grey,leading:17});
    }
    function field(it,en,value,blankRows=2) {
      ensure(43);paragraph(it + ' / ' + en,{font:bold,size:9,leading:15});
      if (txt(value).trim()) paragraph(value);
      else if (blank) {
        for(let i=0;i<blankRows;i++){ensure(19);page.drawLine({start:{x:margin,y:y-8},end:{x:width-margin,y:y-8},thickness:.5,color:pale});y-=19;}
      } else paragraph('Non indicato / Not provided',{color:grey});
      y-=9;
    }
    function pair(left,right) {
      const col=(usable-22)/2;
      const ll=lines(left[1]|| (blank?'______________________':'Non indicato / Not provided'),regular,10,col);
      const rr=lines(right[1]|| (blank?'______________________':'Non indicato / Not provided'),regular,10,col);
      const count=Math.max(ll.length,rr.length), h=20+count*14+11;ensure(h);
      [left[0],right[0]].forEach((v,i)=>page.drawText(v,{x:margin+i*(col+22),y,size:8,font:bold,color:grey}));y-=19;
      for(let i=0;i<count;i++){
        if(ll[i])page.drawText(ll[i],{x:margin,y,size:10,font:regular,color:ink});
        if(rr[i])page.drawText(rr[i],{x:margin+col+22,y,size:10,font:regular,color:ink});y-=14;
      }y-=11;
    }
    newPage();
    if(blank){paragraph('MODELLO DA COMPILARE / BLANK TEMPLATE',{font:bold,size:9,color:grey});y-=7;}
    paragraph('Il tecnico documenta il lavoro eseguito. La chiusura del ticket richiede l\'approvazione del Facility Manager.',{size:9,color:grey,leading:13});
    paragraph('The technician records the work performed. Ticket closure requires Facility Manager approval.',{size:9,color:grey,leading:13});
    section('1  Riferimenti dell\'intervento','Intervention details');
    pair(['Ticket',txt(data.ticket_id)],['Data intervento / Work date',data.work_date]);
    pair(['Tecnico / Technician',data.technician_name],['Email tecnico / Technician email',data.technician_email]);
    pair(['Edificio e locale / Building and room',data.location],['Oggetto o impianto / Asset',data.asset_name]);
    field('Problema segnalato','Reported issue',data.reported_issue,2);
    section('2  Lavoro eseguito','Work performed');
    field('Condizioni riscontrate e causa se nota','Findings and cause if known',data.findings,2);
    field('Operazioni eseguite','Actions performed',data.work_performed,4);
    field('Materiali e ricambi utilizzati','Materials and replacement parts',data.materials,2);

    newPage();
    section('3  Verifiche ed esito','Checks and outcome');
    field('Verifiche eseguite e risultati osservati','Checks performed and observed results',data.checks,3);
    const checkLabels={PASSED:'Superate / Passed',FAILED:'Non superate / Failed',NOT_PERFORMED:'Non eseguite / Not performed'};
    field('Esito delle verifiche','Check result',checkLabels[data.check_result] || (blank?'[ ] Superate / Passed    [ ] Non superate / Failed\n[ ] Non eseguite / Not performed':''),1);
    const outcomeLabels={COMPLETED:'Completato / Completed',PARTIAL:'Parzialmente completato / Partially completed',NOT_COMPLETED:'Non completato / Not completed'};
    field('Esito dichiarato dal tecnico','Technician-declared outcome',outcomeLabels[data.outcome] || (blank?'[ ] Completato / Completed    [ ] Parziale / Partial\n[ ] Non completato / Not completed':''),1);
    field('Problemi residui limitazioni e prossime azioni','Remaining issues limitations and next actions',data.remaining_issues,3);
    section('4  Foto dell\'intervento','Intervention photo optional');
    if(photoDataUrl) {
      // The named attachment identifies AFTER evidence even if future layouts add logos.
      await pdf.attach(photoDataUrl, 'cbm-after-photo.jpg', {mimeType:'image/jpeg',description:'AFTER intervention photo / Foto dopo intervento'});
      const image=await pdf.embedJpg(photoDataUrl);
      const dims=image.scaleToFit(usable,210);
      ensure(dims.height+36);
      page.drawImage(image,{x:margin+(usable-dims.width)/2,y:y-dims.height,width:dims.width,height:dims.height});y-=dims.height+17;
      field('Descrizione della foto','Photo caption',data.photo_caption,1);
    } else if(blank) {
      ensure(103);
      page.drawRectangle({x:margin,y:y-87,width:usable,height:87,borderWidth:.7,borderColor:pale});
      page.drawText('Inserire una foto DOPO l\'intervento / Insert an AFTER photo',{x:margin+14,y:y-26,size:10,font:regular,color:grey});
      page.drawText('La foto fa parte del PDF / The photo is included in the PDF',{x:margin+14,y:y-45,size:9,font:regular,color:grey});
      y-=103;
      field('Descrizione della foto','Photo caption',data.photo_caption,1);
    } else {
      paragraph('Nessuna foto allegata / No photo attached',{color:grey});y-=9;
    }
    section('5  Conferma del tecnico','Technician confirmation');
    paragraph(blank?'[ ] Confermo che questo rapporto descrive il lavoro e le verifiche effettivamente eseguiti.':'Il tecnico conferma che questo rapporto descrive il lavoro e le verifiche effettivamente eseguiti.',{size:9,leading:13});
    paragraph(blank?'I confirm this report describes the work and checks actually performed.':'The technician confirms this report describes the work and checks actually performed.',{size:9,leading:13});
    const pages=pdf.getPages();
    pages.forEach((p,i)=>{
      p.drawLine({start:{x:margin,y:41},end:{x:width-margin,y:41},thickness:.5,color:pale});
      p.drawText('Ticket ' + (data.ticket_id || '________') + '  |  Da valutare dal FM / For FM review',{x:margin,y:27,size:8,font:regular,color:grey});
      p.drawText((i+1)+' / '+pages.length,{x:width-margin-27,y:27,size:8,font:regular,color:grey});
    });
    pdf.setTitle('Rapporto di intervento / Maintenance intervention report');
    pdf.setSubject('CBM technician submission for Facility Manager review');
    pdf.setCreator('CBM technician report template');
    return pdf.save();
  }
  root.CBMReport={createReport};
  if(typeof module!=='undefined')module.exports={createReport};
})(typeof globalThis!=='undefined'?globalThis:this);
