'use strict';
import _ from 'underscore';
import TAS from 'exports-loader?TAS!TheAaronSheet';
import {PFLog, PFConsole} from './PFLog';
import * as SWUtils from './SWUtils';
import PFConst from './PFConst';
import * as PFUtils from './PFUtils';
import * as PFAttacks from './PFAttacks';

export var abilities = ["STR", "DEX", "CON", "INT", "WIS", "CHA"];
export var abilitymods = ["STR-mod", "DEX-mod", "CON-mod", "INT-mod", "WIS-mod", "CHA-mod"];
var columnMods = [ "-base",  "-enhance",  "-inherent",  "-misc",  "-damage",  "-penalty",  "-drain",  "-mod",  "-cond",  "-modded"],
columnBuffMods = [  "-total",  "-total_penalty"],
columnModHelpers=[ "condition-Helpless", "condition-Paralyzed"],
/** map of event types to event string for 'on' function to look for */
events = {
    abilityModAuto: "change:STR-mod change:DEX-mod change:CON-mod change:INT-mod change:WIS-mod change:CHA-mod",
    abilityEventsAuto: "change:REPLACE-cond change:buff_REPLACE-total change:buff_REPLACE-total_penalty", //buffs events handled in PFBuffs
    abilityEventsPlayer: "change:REPLACE-base change:REPLACE-enhance change:REPLACE-inherent change:REPLACE-misc change:REPLACE-temp change:REPLACE-damage change:REPLACE-penalty change:REPLACE-drain"
};

/** for NPC parsing  returns the number and mod for an ability
 * @param {string} numberAsString the ability score -a number in string form
 * @returns {{base: number or '-', mod:number}}
 */
export function getAbilityAndMod (numberAsString) {
	var base = parseInt(numberAsString, 10),
	mod = 0;
	if (!isNaN(base)) {
		mod = Math.floor((base - 10) / 2);
		return {
			"base": base,
			"mod": mod
		};
	}
	if (  PFConst.minusreg.test(numberAsString) ) {
		return {
			"base": "-",
			"mod": 0
		};
	}
	return {
		"base": 10,
		"mod": 0
	};
}
/** for templates: modifies ability-base by val (even #s) and adds the new vals (and ability and mod) to setter.
 * 
 * @param {string} ability 
 * @param {Number} val 
 * @param {Map<string,string>} v 
 * @param {Map<string,number>} setter 
 * @returns {Map<string,number>} returns setter plus updated values for XYZ-base, XYZ-mod , and XYZ
 */
export function updateAbilityBaseDiff (ability,val,v,setter){
    var tempint;
    setter=setter||{};
    ability=ability.toUpperCase();
    tempint = parseInt(v[ability+'-base'],10)||10;
    tempint+=val;
    tempint=Math.max(tempint,1);
    setter[ability+'-base']=tempint;
    tempint = parseInt(v[ability],10)||10;
    tempint+=val;
    tempint=Math.max(tempint,1);
    setter[ability]=tempint;
    tempint=parseInt(v[ability+'-mod'],10)||0;
    tempint+=(Math.floor(val/2));
    tempint=Math.max(tempint,1);
    setter[ability+'-mod']=tempint;
    return setter;    
}

/** Updates each dropdown set to the abilityModName to the newval
 * Dropdown fields are found in PFConst.abilityScoreManualDropdowns
 * @param {string} abilityModName the STR-mod DEX-mod etc name
 * @param {int} newval new value
 * @param {Map<string,int>} v dropdown fields to current values
 * @param {Map<string,int>} setter map to set new values to (optional)
 * @returns {Map<string,int>} setter or new map
 */
function propagateAbilityMod(abilityModName,newval,v,setter){
    setter = setter||{};
    return Object.keys(PFConst.abilityScoreManualDropdowns).filter(function(a){
        return v[a]===abilityModName;
    }).reduce(function(m,a){
        var oldval = parseInt(v[PFConst.abilityScoreManualDropdowns[a]],10)||0;
        if(newval !== oldval){
            m[PFConst.abilityScoreManualDropdowns[a]]=newval;
        }
        return m;
    },setter);
    return setter;
}

/** Looks at the ability-mod changed and then updates rest of sheet. For non repeating
 * @param {string|Array} attr string name of attribute, or array of attributes abilitymods, if null then abilitymods
 * @param {int} newval optional
 * @param {int} oldval ignored
 */
function propagateAbilityModsAsync(callback,silently,attr,newval,oldval){
    var attrs, fields, done = _.once(function(){
        if (typeof callback === "function"){
            callback();
        }
    });
    newval=newval||0;
    if (Array.isArray(attr)){
        attrs = attr;
    } else if(attr){
        attr = attr.slice(0,3).toUpperCase()+'-mod';
        attrs = [attr];
    } else {
        attrs = abilitymods;
    }
    PFAttacks.updateRepeatingWeaponAbilityDropdowns(null,null,attr);    
    fields = attrs;
    fields = fields.concat(Object.keys(PFConst.abilityScoreManualDropdowns));
    fields = fields.concat(_.values(PFConst.abilityScoreManualDropdowns));
    //TAS.debug("propagateAbilityModsAsync about to get fields:",fields);
    getAttrs(fields,function(v){
        var  setter, params ={};
        //TAS.debug("propagateAbilityModsAsync, returned with ",v);
        setter= attrs.reduce(function(m,a){
            var l;
            newval = newval||parseInt(v[attr],10)||0;
            l=propagateAbilityMod(attr,newval,v);
            _.extend(m,l);
            return m;
        },{});
        if(_.size(setter)){
            if (silently){
                params = PFConst.silentParams;
            }
            setAttrs(setter,params,done);
        } else {
            done();
        }
    });
}

/** Looks at current values and calculates new ability , ability-mod and ability-modded values
 * @param {string} ability string matching a value in abilities
 * @param {Map<string,int>} values map of return values from getAttrs
 * @param {Map<string,int>} setter map of values to pass to SWUtils.setWrapper. or null
 * @returns {Map<string,int>}  same setter passed in, with added values if necessary
 */
function setAbilityScore (ability, values, setter) {
    var base = 0,
    newVal = 0,
    rawDmg = 0,
    rawPen = 0,
    dmgAndPen = 0,
    rawCond = 0,
    paralyzed = 0,
    helpless = 0,
    penalized = 0,
    rawDmgAndPen = 0,
    currAbility = 0,
    currMod = 0,
    currPenalized = 0,
    mod = 0;
    try {
        setter = setter || {};
        base = parseInt(values[ability + "-base"], 10);
        //if NaN, make sure it's either empty or has a minus
        if (isNaN(base) && !PFConst.minusreg.test(values[ability+'-base']) ){
            return setter;
        }
        currMod = parseInt(values[ability + "-mod"], 10);
        currPenalized = parseInt(values[ability+"-modded"],10)||0;
        currAbility = parseInt(values[ability], 10);
        if (isNaN(base)) {
            newVal = "-";
            mod = 0;
            penalized = 0;
        } else {
            helpless = parseInt(values["condition-Helpless"], 10) || 0;
            paralyzed = parseInt(values["condition-Paralyzed"],10)||0;
            if (ability === "DEX" && (helpless || paralyzed) ) {
                newVal = 0;
                mod = -5;
                penalized = 1;
            } else if (ability==="STR" && paralyzed){
                newVal = 0;
                mod = -5;
                penalized = 1;
            } else {
                newVal = base + (parseInt(values[ability + "-enhance"], 10) || 0) + 
                    (parseInt(values[ability + "-inherent"], 10) || 0) + (parseInt(values[ability + "-misc"], 10) || 0) + 
                    (parseInt(values[ability + "-drain"], 10) || 0) + (parseInt(values["buff_" + ability + "-total"], 10) || 0);
                rawDmg = Math.abs(parseInt(values[ability + "-damage"], 10) || 0);
                if (rawDmg >= newVal || newVal <= 0) {
                    newVal = 0;
                    mod = -5;
                    penalized = 1;
                } else {
                    rawPen = Math.abs(parseInt(values[ability + "-penalty"], 10) || 0) + Math.abs(parseInt(values["buff_" + ability + "-total_penalty"], 10) || 0);
                    rawCond = Math.abs(parseInt(values[ability + "-cond"], 10) || 0);
                    rawDmgAndPen = rawDmg + rawPen + rawCond;
                    if (rawDmgAndPen >= newVal ) {
                        newVal = currAbility;
                        mod = -5;
                        penalized = 1;
                    } else {
                        //normal
                        if (rawDmgAndPen !== 0) {
                            penalized = 1;					
                        }
                        dmgAndPen = Math.floor(rawDmgAndPen / 2);
                        mod = Math.max(-5,Math.floor((newVal - 10) / 2) - dmgAndPen);
                    }
                }
            }
        }
        if (currAbility !== newVal ) {
            setter[ability] = newVal;
        }
        if (currMod !== mod || isNaN(currMod)) {
            setter[ability + "-mod"] = mod;
        }
        if (penalized !== currPenalized){
            setter[ability + "-modded"] = penalized;
        }
    } catch (err) {
        TAS.error("updateAbilityScore:" + ability, err);
    } finally {
        return setter;
    }
}

/** Updates the final ability score, ability modifier, condition column based on entries in ability grid plus conditions and buffs.
 * Note: Ability value is not affected by damage and penalties, instead only modifier is affected.
 * @param {string} ability 3 letter abbreviation for one of the 6 ability scores, member of PFAbilityScores.abilities
 */
export function setAbilityScoreAsync (ability,eventInfo,callback,silently){
    var done = _.once(function () {
        if (typeof callback === "function") {
            callback();
        }
    }),
    getAttributes = function(ability){
        var fields = _.map(columnMods,function(col){return ability+col;});
        fields.push(ability);
        fields = fields.concat( _.map(columnBuffMods,function(col){
            return 'buff_'+ability+col;
        }));
        fields = fields.concat(columnModHelpers);
        return fields;
    },
    fields = getAttributes(ability);
    getAttrs(fields,function(v){
        var params = {}, setter={};
        setAbilityScore(ability,v,setter);
        if (_.size(setter) ) {
            if (silently) {
                params = PFConst.silentParams;
            }
            SWUtils.setWrapper(setter, params, done);
        } else {
            done();
        }
    });
}
/** calls getAbilityScore for all abilities */
function setAllAbilityScoresAsync (callback, silently) {
    var done = _.once(function () {
        if (typeof callback === "function") {
            callback();
        }
    }),
    getAllAttributes = function(){
        var fields = SWUtils.cartesianAppend(abilities,columnMods);
        fields = fields.concat(abilities);
        fields = fields.concat(SWUtils.cartesianAppend(['buff_'],abilities,columnBuffMods));
        fields = fields.concat(columnModHelpers);
        return fields;
    },
    fields = getAllAttributes();
    getAttrs(fields,function(v){
        var params = {}, setter={};
        setter = _.reduce(abilities,function(m,a){
                setAbilityScore(a,v,m);
                return m;
            },{});
        if (_.size(setter) ) {
            if (silently) {
                params = PFConst.silentParams;
            }
            SWUtils.setWrapper(setter, params, done);
        } else {
            done();
        }
    });
}

/** Quick update to ability score.
 * If only abilityScore changes and not modifier, then sets silently.
 * can make faster if we make different version for penalty/damage and regular updates
 * 
 * @param {function} callback when done
 * @param {boolean} silently whether to set {silent:true} in setAttrs
 * @param {string} attrib the attribute modified
 * @param {int} newVal new value of attrib
 * @param {int} oldVal old value of attrib
 */
function updateAbilityScoreDiffAsync (callback, silently, attrib, newVal, oldVal){
    var abilityName='',abilityMod='',attributes=[],attribType='';
    if(attrib.indexOf('-')>0){
        abilityName=attrib.slice(0,attrib.indexOf('-'));
        attribType=attrib.slice(attrib.indexOf('-')+1);
        //if it's a buff we have to handle differently
        if (abilityName.indexOf('buff_')===0){
            //also attrib will be 'total' or 'total_penalty'
            abilityName = abilityName.slice(5);
        }
    } else {
        //should not happen if from user
        //we don't use this function for worksheet
        if(typeof callback === "function") {
            callback();
        }
        return;
    }
    abilityName=abilityName.toUpperCase();
    abilityMod=abilityName+'-mod';
    attributes = [abilityName,abilityMod];
    attribType=attribType.toLowerCase();
    if (abilityName ==='DEX' || abilityName==='STR'){
        attributes.push('condition-Helpless');
        attributes.push('condition-Paralyzed');
    }
    if(attribType==='penalty'||attribType==='total_penalty'||attribType==='cond'){
        attributes.push(abilityName+'-penalty');
        attributes.push('buff_'+abilityName+'-total_penalty');
        attributes.push(abilityName+'-cond');
        attributes.push(abilityName+'-modded');
    }
    getAttrs(attributes,function(v){
        var setter={},currAbility=0,currMod=0,modded=0,diff=0,absdiff=0,newAbility=0,newMod=0,tempInt=0,params={};
        try{
            //if paralyzed or helpless, dont even bother updating str or dex
            currAbility=parseInt(v[abilityName],10);
            if ( currAbility === 0 || 
                ((abilityName==='STR' ||abilityName==='DEX') && ((parseInt(v['condition-Paralyzed'],10)||0)===1)) ||
                (abilityName==='DEX' && ((parseInt(v['condition-Helpless'],10)||0)===1)) ) {
                if (typeof callback === "function"){
                    callback();
                }
                return;
            }
            newAbility=currAbility;
            currMod=parseInt(v[abilityMod],10)||0;
            diff=newVal-oldVal;
            newMod=currMod;
            switch(attribType) {
                case 'cond':
                case 'penalty':
                case 'total_penalty':
                    //for penalties, all 3 add up to total penalty
                    newVal = (parseInt(v['buff_'+abilityName+'-total_penalty'],10)||0) +
                        (parseInt(v[abilityName+'-cond'],10)||0) + 
                        (parseInt(v[abilityName+'-penalty'],10)||0);                
                case 'damage':
                    modded = parseInt(v[abilityName+'-modded'],10)||0;
                    absdiff=Math.abs(diff);
                    if ( !(newVal % 2) || absdiff > 1) {
                        tempInt = Math.floor( (absdiff+1)/2);
                        if (diff<0){
                            tempInt= tempInt * -1;
                        }
                        newMod=currMod+tempInt;
                    }
                    if (newVal!==0 && modded!==1){
                        setter[abilityName+'-modded']=1;
                    } else if (newVal===0 && modded === 1) {
                        setter[abilityName+'-modded']=0;
                    }
                    break;
                case 'base':
                case 'enhance':
                case 'drain':
                case 'total':
                case 'inhernet':
                case 'misc':
                default:
                    newAbility=currAbility+diff;
                    if ( !(newAbility % 2) || absdiff > 1) {
                        newMod=Math.floor((newAbility - 10) / 2);
                    }
                    break;
            }
            if (newMod < -5){
                newMod = -5;
            }
            if(newAbility!==currAbility){
                setter[abilityName]=newAbility;
            }
            if(newMod!==currMod){
                setter[abilityMod]=newMod;
            } else {
                silently=true;
            }
        } catch (err){
            TAS.error("PFAbilityScores.updateAbilityScoreDiff error:",err);
        } finally {
            if(_.size(setter)>0){
                if(silently){
                    params=PFConst.silentParams;
                }
                SWUtils.setWrapper(setter,params,callback);
            } else if(typeof callback === "function") {
                callback();
            }
        }
    });
}

/** applies conditions for exhausted, fatigued, entangled, grappled
 * for paralyzed and helpless sets but does not unset- so we don't call it for those , can remove or else
 * need to unset
 * 
 * @param {*} callback 
 * @param {*} silently 
 * @param {*} eventInfo 
 */
export function applyConditions (callback, silently, eventInfo) {
    getAttrs(["STR-cond", "DEX-cond", "condition-Helpless","condition-Paralyzed", "condition-Exhausted", "condition-Fatigued", "condition-Entangled", "condition-Grappled"], function (v) {
        var setter = {}, silentSetter={}, params = {}, tempInt=0,
        strMod = 0, dexMod = 0, helpless = 0, paralyzed = 0, dexAbMod = 0, strAbMod = 0;
        try {
            //TAS.debug("PFAbilityScores.applyconditions: ",v);
            helpless = parseInt(v.helpless,10)||0;
            paralyzed = parseInt(v.paralyzed,10)||0;
            if (paralyzed){
                silentSetter["DEX"] = 0;
                silentSetter["DEX-modded"]=1;
                setter["DEX-mod"] = -5;
                silentSetter["STR"] = 0;
                silentSetter["STR-modded"]=1;
                setter["STR-mod"] = -5;
            }
            if (helpless){
                silentSetter["DEX"] = 0;
                silentSetter["DEX-modded"]=1;
                setter["DEX-mod"] = -5;
            } 
            strMod = (parseInt(v["condition-Fatigued"], 10) || 0) + (parseInt(v["condition-Exhausted"], 10) || 0);
            dexMod = strMod + (parseInt(v["condition-Entangled"], 10) || 0) + (parseInt(v["condition-Grappled"], 10) || 0);
            dexAbMod = dexMod * -2;
            strAbMod = strMod * -2;
            if (dexAbMod !== (parseInt(v["DEX-cond"], 10) || 0)) {
                setter["DEX-cond"] = dexAbMod;
            }
            if (strAbMod !== (parseInt(v["STR-cond"], 10) || 0)) {
                setter["STR-cond"] = strAbMod;
            }
            
        } catch (err) {
            TAS.error("PFAbilityScores.applyConditions", err);
        } finally {
            if(silently){
                _.extend(silentSetter,setter);
                if(_.size(silentSetter)){
                    setAttrs(silentSetter,PFConst.silentParams,callback);
                } else if (typeof callback === "function") {
                    callback();
                }
            } else if(_.size(setter)){
                if(_.size(silentSetter)){
                    setAttrs(silentSetter,PFConst.silentParams);
                }          
                setAttrs(setter,{},callback);
            } else if(_.size(silentSetter)){
                setAttrs(silentSetter,PFConst.silentParams,callback);
            } else if (typeof callback === "function") {
                callback();
            }
        }
    });
}
/** calls updateAbilityScoreDiffAsync if there is a change */
function updateAbilityScoreDiffQuick (eventInfo){
    var prev=parseInt(eventInfo.previousValue,10),
        newv=parseInt(eventInfo.newValue,10);
    if(!isNaN(newv) && !isNaN(newv) && prev!==newv){
        updateAbilityScoreDiffAsync(null,false,eventInfo.sourceAttribute,newv,prev);
    }
}
/** calls propagateAbilityModsAsync if there is a change */
function updateAbilityScoreModQuick (eventInfo){
    var prev=parseInt(eventInfo.previousValue,10),
        newv=parseInt(eventInfo.newValue,10);
    if(!isNaN(newv) && !isNaN(newv) && prev!==newv){
        propagateAbilityModsAsync(null,false,eventInfo.sourceAttribute,newv,prev);
    }
}

/** migrate (currently empty just calls callback*/
export var migrate = TAS.callback(function callPFAbilityScoreMigrate(callback,oldversion){
    if (typeof callback === "function"){
        callback();
    }
});
/** recalculates all attributes written to by this module. */
export var recalculate = TAS.callback(function callPFAbilityScoresRecalculate(callback, silently, oldversion) {
    var done = _.once(function () {
        TAS.info("leaving PFAbilityScores.recalculate");
        if (typeof callback === "function") {
            callback();
        }
    }),
    updateDependentAttrs = _.once(function(){
        propagateAbilityModsAsync(done,silently);
    }),
    updateScoresOnce = _.once(function () {
        setAllAbilityScoresAsync(updateDependentAttrs, silently);
    });
    migrate(function(){
        applyConditions(updateScoresOnce, silently);
    },oldversion);
});

/** Calls 'on' function for everything related to this module */
function registerEventHandlers () {

    var tempEventToWatch=abilities.map(function(ability){
        return events.abilityEventsAuto.replace(/REPLACE/g, ability);
    }).join(' ');

    on(tempEventToWatch, TAS.callback(function eventUpdateAbilityAuto(eventInfo) {
        if (eventInfo.sourceType === "sheetworker" || eventInfo.sourceType === "api") {
            TAS.debug("caught " + eventInfo.sourceAttribute + " event: " + eventInfo.sourceType,eventInfo);
            updateAbilityScoreDiffQuick(eventInfo);
        }
    }));

    tempEventToWatch=abilities.map(function(ability){
        return events.abilityEventsPlayer.replace(/REPLACE/g, ability);
    }).join(' ');

    on(tempEventToWatch, TAS.callback(function eventUpdateAbilityPlayer(eventInfo) {
        if (eventInfo.sourceType === "player" || eventInfo.sourceType === "api") {
            TAS.debug("caught " + eventInfo.sourceAttribute + " event: " + eventInfo.sourceType,eventInfo,eventInfo);
            updateAbilityScoreDiffQuick(eventInfo);
        }
    }));

  
    on(events.abilityModAuto, TAS.callback(function eventUpdateAbilityModAuto(eventInfo){
        TAS.debug("caught " + eventInfo.sourceAttribute + " event: " + eventInfo.sourceType, eventInfo);
        if (eventInfo.sourceType==="sheetworker" || eventInfo.sourceType === "api"){
            updateAbilityScoreModQuick(eventInfo);
        }
    }));
}
registerEventHandlers();
