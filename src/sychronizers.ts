import { Injector } from "@angular/core";
import { Synchronizer } from "./synchronizer";

export class Synchronizers {

    public readonly collections: Synchronizers.Dictionary = {};

    constructor(injector: Injector, collectionBuilder: Synchronizers.BuilderDictionary) {
        for (const stateName in collectionBuilder) {
            const synchronizers = collectionBuilder[stateName];

            if (Array.isArray(synchronizers)) {
                // Inject each Synchronizer dependency into the collection
                this.collections[stateName] = new Synchronizer.Collection<any>(...synchronizers.map(dep => injector.get(dep)));
            } else {
                // Inject the single Synchronizer into a SingletonCollection
                this.collections[stateName] = new Synchronizer.SingletonCollection<any>(injector.get(synchronizers));
            }
        }
    }

    public setCollection<T>(stateName: string, collection: Synchronizer.ICollection<T>) {
        this.collections[stateName] = collection;
    }

    public getCollection<T>(stateName: string): Synchronizer.ICollection<T> {
        const collection = this.collections[stateName] as Synchronizer.ICollection<T>;

        if (collection) {
            return collection;
        } else {
            throw new Error(`No synchronizer collection defined for state name "${stateName}".`);
        }
    }
}

export namespace Synchronizers {

    export type Creator = new(...args: any[]) => Synchronizer<any, any>;

    export type Dictionary = {
        [stateName: string]: Synchronizer.ICollection<any>
    };

    export type BuilderDictionary = {
        [stateName: string]: Creator[] | Creator
    };
}
